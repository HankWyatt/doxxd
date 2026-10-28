import { afterEach, expect, it, vi } from "vitest";
import { createDmndClient } from "./client.server";
import type { ResourceName, Schemas } from "./contracts";
import { resourceResponse } from "./http";
import { protocolResources, resources } from "./resources";
const wallet = "11111111111111111111111111111111";
const env = {
  DMND_API_BASE_URL: "https://api.example.test/api/v1",
  DMND_API_KEY: "synthetic-secret",
  DMND_ENABLED_PROTOCOLS: "orca",
};
const summary = {
  wallet,
  components: [],
  known_component_net_value_usd: "12345.67",
  valuation_consistency: "independent_snapshots",
  whole_wallet_complete: false,
  unsupported_scopes: [],
};
const positions: Schemas["WalletPositions"] = {
  wallet,
  data: [],
  has_more: false,
  position_count: 0,
  positions_tracked: true,
  sort: "total_pnl",
};
const reply = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => new Response(JSON.stringify(body), { status, headers });
afterEach(() => vi.useRealTimers());
it("uses the fixed positions route without protocol activation or summary inclusion", async () => {
  const network = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe(`/api/v1/wallets/${wallet}/positions`);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("cursor")).toBe("a+b/=");
    expect(url.searchParams.get("sort")).toBe("last_active");
    expect(url.searchParams.has("protocol")).toBe(false);
    return reply({ ...positions, sort: "last_active" });
  });
  expect(protocolResources).not.toContain("positions");
  expect(resources.positions.componentId).toBeUndefined();
  const result = await createDmndClient(
    { ...env, DMND_ENABLED_PROTOCOLS: "" },
    network,
  ).read(wallet, "positions", {
    limit: 100,
    cursor: "a+b/=",
    sort: "last_active",
  });
  expect(result).toEqual({
    ok: true,
    data: { ...positions, sort: "last_active" },
  });
  expect(network).toHaveBeenCalledTimes(1);
});
it.each([
  { limit: 101 },
  { sort: "unexpected" },
  { from: "2026-10-22T00:00:00Z" },
  { to: "2026-10-22T00:00:00Z" },
  { mint: wallet },
  { window: "7d" },
])("rejects unsupported positions filters before fetching %j", async (query) => {
  const network = vi.fn();
  expect(
    await createDmndClient(env, network).read(wallet, "positions", query as never),
  ).toEqual({ ok: false, kind: "invalid_input" });
  expect(network).not.toHaveBeenCalled();
});
it("rejects a positions response for another wallet", async () => {
  expect(
    await createDmndClient(env, async () =>
      reply({ ...positions, wallet: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx" }),
    ).read(wallet, "positions"),
  ).toEqual({ ok: false, kind: "upstream" });
});
it.each([undefined, "value"] as const)(
  "rejects a positions page whose sort differs from requested %s",
  async (sort) => {
    const body = {
      ...positions,
      sort: "last_active",
      has_more: true,
      cursor: "wrong-sort-next-page",
    };
    expect(
      await createDmndClient(env, async () => reply(body)).read(
        wallet,
        "positions",
        { cursor: "requested-page", sort },
      ),
    ).toEqual({ ok: false, kind: "upstream" });
  },
);
it("refuses an oversized successful payload without reading it as a wallet result", async () => {
  expect(
    await createDmndClient(env, async () =>
      reply(summary, 200, { "content-length": "9000000" }),
    ).read(wallet, "summary"),
  ).toEqual({ ok: false, kind: "refused" });
});
it("enforces an optional wallet allowlist and a shared request budget before upstream reads", async () => {
  const network = vi.fn(async () => reply(summary));
  const client = createDmndClient(
    { ...env, DMND_ALLOWED_WALLETS: wallet, DMND_REQUEST_BUDGET: "1" },
    network,
  );
  expect(
    await client.read("J3jHGNUJMKHZnC8iTnnMGx5Vii5fjXBuh5Rc6K6feZ38", "summary"),
  ).toEqual({ ok: false, kind: "unavailable" });
  expect(await client.read(wallet, "summary")).toEqual({
    ok: true,
    data: summary,
  });
  expect(await client.read(wallet, "overview")).toEqual({
    ok: false,
    kind: "refused",
  });
  expect(network).toHaveBeenCalledTimes(1);
});
it.each(["0", "35", "1.5", "NaN"])(
  "rejects an invalid bounded request budget %s",
  async (budget) => {
    const network = vi.fn();
    expect(
      await createDmndClient(
        { ...env, DMND_REQUEST_BUDGET: budget },
        network,
      ).read(wallet, "summary"),
    ).toEqual({ ok: false, kind: "configuration" });
    expect(network).not.toHaveBeenCalled();
  },
);
it("turns an expired upstream cursor into recoverable invalid input", async () => {
  expect(
    await createDmndClient(env, async () =>
      reply({ message: "expired synthetic-secret" }, 400),
    ).read(wallet, "transactions", { cursor: "expired" }),
  ).toEqual({ ok: false, kind: "invalid_input" });
});
it.each([401, 403] as const)(
  "retains service authentication failure %s without its body",
  async (status) => {
    const result = await createDmndClient(env, async () =>
      reply({ message: "synthetic-secret" }, status),
    ).read(wallet, "summary");
    expect(result).toEqual({
      ok: false,
      kind: "authentication",
      upstreamStatus: status,
    });
    expect(resourceResponse(result).status).toBe(status);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  },
);
it("retains scoped refusal as an error rather than an empty result", async () => {
  const result = await createDmndClient(env, async () =>
    reply({ message: "synthetic-secret" }, 422),
  ).read(wallet, "transactions");
  expect(result).toEqual({ ok: false, kind: "refused" });
  expect(resourceResponse(result).status).toBe(422);
});
it("keeps missing credentials and bad inputs away from upstream", async () => {
  const network = vi.fn();
  expect(await createDmndClient({}, network).read(wallet, "summary")).toEqual({
    ok: false,
    kind: "configuration",
  });
  expect(await createDmndClient(env, network).read("bad", "summary")).toEqual({
    ok: false,
    kind: "invalid_input",
  });
  expect(
    await createDmndClient(env, network).read(" " + wallet + " ", "summary"),
  ).toEqual({ ok: false, kind: "invalid_input" });
  expect(
    await createDmndClient(env, network).read(
      wallet,
      "made-up" as ResourceName,
    ),
  ).toEqual({ ok: false, kind: "invalid_input" });
  expect(network).not.toHaveBeenCalled();
});
it("uses only fixed protocol routes and preserves decimal totals", async () => {
  const network = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.example.test");
      expect(url.searchParams.get("api_key")).toBe("synthetic-secret");
      expect(init?.redirect).toBe("manual");
      return reply(summary);
    },
  );
  expect(await createDmndClient(env, network).read(wallet, "summary")).toEqual({
    ok: true,
    data: summary,
  });
});
it("coalesces identical reads and separates wallets", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const network = vi.fn(async () => {
    await gate;
    return reply(summary);
  });
  const client = createDmndClient(env, network);
  const a = client.read(wallet, "summary"),
    b = client.read(wallet, "summary");
  release();
  expect(await a).toEqual(await b);
  expect(network).toHaveBeenCalledTimes(1);
  await client.read(wallet, "summary");
  expect(network).toHaveBeenCalledTimes(2);
});
it.each([
  {},
  { ...summary, wallet: "another-wallet" },
  { ...summary, known_component_net_value_usd: 42 },
])("rejects malformed or mismatched data", async (body) => {
  expect(
    await createDmndClient(env, async () => reply(body)).read(
      wallet,
      "summary",
    ),
  ).toEqual({ ok: false, kind: "upstream" });
});
it("redacts upstream errors and refuses redirects", async () => {
  for (const status of [302, 500]) {
    const result = await createDmndClient(env, async () =>
      reply({ error: "synthetic-secret" }, status),
    ).read(wallet, "summary");
    expect(result).toEqual({ ok: false, kind: "upstream" });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  }
});
it("distinguishes explicit unsupported from temporarily unavailable", async () => {
  expect(
    await createDmndClient(env, async () => reply({}, 501)).read(
      wallet,
      "transactions",
    ),
  ).toEqual({ ok: false, kind: "unsupported" });
  expect(
    await createDmndClient(env, async () => reply({}, 503)).read(
      wallet,
      "transactions",
    ),
  ).toEqual({ ok: false, kind: "unavailable" });
});
it("preserves a rate limit without retrying", async () => {
  const network = vi.fn(async () => reply({}, 429, { "retry-after": "15" }));
  expect(await createDmndClient(env, network).read(wallet, "summary")).toEqual({
    ok: false,
    kind: "rate_limited",
    retryAfterSeconds: 15,
  });
  expect(network).toHaveBeenCalledTimes(1);
});
it("times out instead of hanging or retrying", async () => {
  vi.useFakeTimers();
  const network = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("timed out", "AbortError")),
        ),
      ),
  );
  const result = createDmndClient(env, network).read(wallet, "summary");
  await vi.advanceTimersByTimeAsync(8001);
  expect(await result).toEqual({ ok: false, kind: "timeout" });
  expect(network).toHaveBeenCalledTimes(1);
});
it.each([
  "https://user:pass@example.test",
  "http://remote.example.test",
  "https://example.test?api_key=oops",
])("rejects unsafe configuration %s", async (base) => {
  expect(
    await createDmndClient({ ...env, DMND_API_BASE_URL: base }).read(
      wallet,
      "summary",
    ),
  ).toEqual({ ok: false, kind: "configuration" });
});
