import { expect, it, vi } from "vitest";
import { runAcceptance } from "../../scripts/dmnd-acceptance.mjs";
const wallet = "7yW6xxcWv2bGX2KkXDCf8qx9Fu7JXraT2m2YZ2f3tWsa";
const baseURL = "http://127.0.0.1:4317";
it("runs sequential bounded pages with the same wallet and UTC scope", async () => {
  const paths: string[] = [];
  let active = 0;
  let peak = 0;
  const network = vi.fn(async (input: string) => {
    active++;
    peak = Math.max(peak, active);
    const url = new URL(input);
    paths.push(url.pathname + url.search);
    await Promise.resolve();
    active--;
    return Response.json({
      ok: true,
      data: {
        wallet,
        data: [],
        cursor: url.searchParams.has("cursor") ? null : "opaque+/",
        has_more: !url.searchParams.has("cursor"),
        coverage: { complete_since_slot: false, reason: "not_indexed" },
      },
    });
  });
  const report = await runAcceptance(
    {
      baseURL,
      wallets: [wallet],
      resources: ["transactions", "activity"],
      from: "2026-10-22T00:00:00Z",
      to: "2026-10-23T00:00:00Z",
      continuation: true,
      maxRequests: 3,
    },
    network,
  );
  expect(peak).toBe(1);
  expect(report.requests).toBe(3);
  expect(paths).toHaveLength(3);
  for (const path of paths) {
    const url = new URL(path, baseURL);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("from")).toBe("2026-10-22T00:00:00Z");
    expect(url.searchParams.get("to")).toBe("2026-10-23T00:00:00Z");
  }
  expect(new URL(paths[1], baseURL).searchParams.get("cursor")).toBe(
    "opaque+/",
  );
  expect(report.results.every((r: any) => r.observations === 0)).toBe(true);
});
it("does not invent a limit on unpaged resources or leak extra upstream fields", async () => {
  const network = vi.fn(async (input: string) => {
    expect(new URL(input).search).toBe("");
    return Response.json({
      ok: true,
      data: {
        wallet,
        assets: [{ amount: "9007199254740993", note: "synthetic-secret" }],
        unpriced_asset_count: 1,
        coverage: {
          complete: false,
          native_sol_slot: null,
          reason: "snapshot_running",
        },
        debug: "synthetic-secret",
      },
    });
  });
  const report = await runAcceptance(
    { baseURL, wallets: [wallet], resources: ["overview"] },
    network,
  );
  expect(report.results[0].observations).toBe(1);
  expect(report.results[0].coverage.complete).toBe(false);
  expect(JSON.stringify(report)).not.toContain("synthetic-secret");
});
it.each([
  {
    baseURL,
    wallets: ["11111111111111111111111111111111"],
    resources: ["summary"],
  },
  { baseURL, wallets: [wallet], resources: ["summary"], maxRequests: 35 },
  {
    baseURL: "https://remote.example.test",
    wallets: [wallet],
    resources: ["summary"],
  },
  {
    baseURL,
    wallets: [wallet],
    resources: ["summary"],
    apiKey: "synthetic-secret",
  },
])("refuses requests outside the approved acceptance scope", async (config) => {
  const network = vi.fn();
  await expect(runAcceptance(config, network)).rejects.toThrow(
    "Invalid acceptance configuration",
  );
  expect(network).not.toHaveBeenCalled();
});
it("does not retry errors or include their raw text", async () => {
  const network = vi.fn(
    async () => new Response("synthetic-secret", { status: 429 }),
  );
  const report = await runAcceptance(
    { baseURL, wallets: [wallet], resources: ["overview"], continuation: true },
    network,
  );
  expect(network).toHaveBeenCalledTimes(1);
  expect(report.results[0]).toMatchObject({ ok: false, status: 429 });
  expect(JSON.stringify(report)).not.toContain("synthetic-secret");
});
it("caps response bytes and cannot be redirected away from the proxy", async () => {
  const network = vi.fn(async (_input: string, init: any) => {
    expect(init.redirect).toBe("manual");
    return new Response("x", { headers: { "content-length": "9000000" } });
  });
  const report = await runAcceptance(
    { baseURL, wallets: [wallet], resources: ["overview"] },
    network,
  );
  expect(report.results[0]).toMatchObject({
    ok: false,
    error: "response_too_large",
  });
});
it("caps streamed bodies even without a declared length", async () => {
  const network = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          controller.close();
        },
      }),
    );
  const report = await runAcceptance(
    { baseURL, wallets: [wallet], resources: ["overview"] },
    network,
  );
  expect(report.results[0]).toMatchObject({
    ok: false,
    error: "response_too_large",
  });
});
it("retains the acquisition status and independent unknown SOL quantities in receipts", async () => {
  const network = async () =>
    Response.json({
      ok: true,
      data: {
        wallet,
        assets: [],
        native_sol_lamports: null,
        wrapped_sol_lamports: null,
        coverage: {
          complete: false,
          snapshot_status: "budget_wait",
          reason: "snapshot_budget_wait",
          native_sol_slot: null,
          wrapped_sol_slot: 123,
        },
      },
    });
  const report = await runAcceptance(
    { baseURL, wallets: [wallet], resources: ["overview"] },
    network,
  );
  expect(report.results[0].coverage).toMatchObject({
    complete: false,
    snapshot_status: "budget_wait",
    reason: "snapshot_budget_wait",
    native_sol_slot: null,
    wrapped_sol_slot: 123,
  });
  expect(report.results[0].nativeSolLamports).toBeNull();
  expect(report.results[0].wrappedSolLamports).toBeNull();
});
