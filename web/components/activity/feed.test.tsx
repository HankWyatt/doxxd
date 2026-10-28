import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL as NodeURL } from "node:url";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Activity } from "./feed";
import { DEMO_ADDRESS, readFixture } from "@/lib/fixtures/wallet";
import type { ResourceName, FixtureScenario, ResourceData } from "@/lib/dmnd/contracts";
import { validResourcePayload } from "@/lib/dmnd/validation.server";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());
it("offers a seed link preserving date bounds after a refused cursor", async () => {
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input, "http://test");
    return url.pathname.endsWith("/transactions")
      ? Response.json({ ok: false, kind: "refused" }, { status: 422 })
      : Response.json({ ok: false, kind: "configuration" }, { status: 503 });
  });
  render(
    <Activity
      address={DEMO_ADDRESS}
      cursor="expired"
      window={{ from: "2026-10-22T00:00:00Z" }}
    />,
  );
  const reset = await screen.findByRole("link", { name: "Newest activity" });
  const url = new URL(reset.getAttribute("href")!, "http://test");
  expect(url.pathname).toBe("/wallet/" + DEMO_ADDRESS + "/activity");
  expect(url.searchParams.get("from")).toBe("2026-10-22T00:00:00Z");
  expect(url.searchParams.has("cursor")).toBe(false);
});
function network(scenario: FixtureScenario = "complete", unsupported = false) {
  const request = vi.fn(async (input: string) => {
    const url = new URL(input, "http://test");
    const resource = url.pathname.split("/").at(-1) as ResourceName;
    if (
      resource === "transactions" &&
      Number(url.searchParams.get("limit")) > 25
    )
      return new Response(
        JSON.stringify({ ok: false, kind: "invalid_input" }),
        { status: 400 },
      );
    if (unsupported && resource === "transactions")
      return new Response(JSON.stringify({ ok: false, kind: "unsupported" }));
    return new Response(
      JSON.stringify(
        resource === "summary"
          ? { ok: false, kind: "configuration" }
          : readFixture(resource, scenario),
      ),
    );
  });
  vi.stubGlobal("fetch", request);
  return request;
}
it("shows grouped activity independently of unavailable portfolio valuation", async () => {
  network();
  render(<Activity address={DEMO_ADDRESS} />);
  expect(await screen.findByText("Observed executions")).toBeVisible();
  expect(screen.getByText("Network fee")).toBeVisible();
  expect(screen.getByText("Data connection unavailable")).toBeVisible();
});
it("retains pagination on an empty activity page", async () => {
  network("activity-continuation");
  render(
    <Activity
      address={DEMO_ADDRESS}
      mode={{ kind: "demo", scenario: "activity-continuation" }}
    />,
  );
  expect(
    await screen.findByRole("link", { name: /load more/i }),
  ).toHaveAttribute("href", expect.stringContaining("cursor=demo-next"));
  expect(screen.getByText(/another page is available/i)).toBeVisible();
});
it("distinguishes incomplete capture from no wallet history", async () => {
  network("pending");
  render(<Activity address={DEMO_ADDRESS} />);
  expect(
    await screen.findByText(/No indexed activity is available yet/i),
  ).toBeVisible();
});
it("preserves source truncation inside expanded transaction details", async () => {
  network("truncated");
  render(<Activity address={DEMO_ADDRESS} />);
  const buttons = await screen.findAllByRole("button", {
    name: /inspect transaction/i,
  });
  fireEvent.click(buttons[0]);
  expect(
    screen.getByText(/More executions were observed than are included/i),
  ).toBeVisible();
});
it("uses a neutral feed only after explicit unsupported response", async () => {
  network("complete", true);
  render(<Activity address={DEMO_ADDRESS} />);
  expect(await screen.findByText("Balance-change feed")).toBeVisible();
  expect(screen.queryByText("Observed executions")).not.toBeInTheDocument();
});

function continuationNetwork(
  source: "transactions" | "activity",
  cursor: string | null,
  empty = true,
) {
  const result = readFixture(source, "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  result.data.has_more = true;
  result.data.cursor = cursor;
  if (empty) result.data.data = [];
  expect(validResourcePayload(source, result.data)).toBe(true);
  const request = vi.fn(async (input: string) => {
    const url = new URL(input, "http://test");
    const resource = url.pathname.split("/").at(-1) as ResourceName;
    if (resource === source) return Response.json(result);
    if (resource === "transactions" && source === "activity")
      return Response.json({ ok: false, kind: "unsupported" });
    return Response.json(
      resource === "summary"
        ? { ok: false, kind: "configuration" }
        : readFixture(resource, "complete"),
    );
  });
  vi.stubGlobal("fetch", request);
  const calls = () =>
    request.mock.calls.filter(([input]) =>
      new URL(input, "http://test").pathname.endsWith("/" + source),
    );
  return { request, data: result.data, calls };
}
it.each([null, "", " \t"])(
  "reports unavailable grouped continuation instead of empty history for cursor %j",
  async (cursor) => {
    const { data, calls } = continuationNetwork("transactions", cursor);
    const window = {
      from: "2026-10-22T00:00:00Z",
      to: "2026-10-23T00:00:00Z",
    };
    render(<Activity address={DEMO_ADDRESS} window={window} cursor="current-page" />);
    expect(await screen.findByRole("status", { name: "Activity continuation" })).toHaveTextContent(
      /continuation unavailable/i,
    );
    expect(screen.getByText("No matches on this page")).toBeVisible();
    expect(screen.queryByText("No observed transactions in this window")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /load more/i })).not.toBeInTheDocument();
    expect(calls()).toHaveLength(1);
    const retry = screen.getByRole("button", { name: "Retry activity page" });
    const newest = new URL(
      screen.getByRole("link", { name: "Newest activity" }).getAttribute("href")!,
      "http://test",
    );
    expect(newest.searchParams.get("from")).toBe(window.from);
    expect(newest.searchParams.get("to")).toBe(window.to);
    expect(newest.searchParams.has("cursor")).toBe(false);
    data.cursor = "next:opaque++/=";
    fireEvent.click(retry);
    const next = new URL(
      (await screen.findByRole("link", { name: /load more/i })).getAttribute("href")!,
      "http://test",
    );
    expect(next.searchParams.get("cursor")).toBe("next:opaque++/=");
    expect(next.searchParams.get("from")).toBe(window.from);
    expect(next.searchParams.get("to")).toBe(window.to);
    expect(screen.queryByRole("status", { name: "Activity continuation" })).not.toBeInTheDocument();
    await waitFor(() => expect(calls()).toHaveLength(2));
    for (const [input] of calls()) {
      const request = new URL(input, "http://test");
      expect(request.searchParams.get("cursor")).toBe("current-page");
      expect(request.searchParams.get("from")).toBe(window.from);
      expect(request.searchParams.get("to")).toBe(window.to);
    }
  },
);
it("retains grouped observations and details when continuation is unavailable", async () => {
  const { data, calls } = continuationNetwork("transactions", null, false);
  const snapshot = structuredClone(data);
  render(<Activity address={DEMO_ADDRESS} />);
  expect(await screen.findByText("Observed executions")).toBeVisible();
  expect(await screen.findByRole("status", { name: "Activity continuation" })).toHaveTextContent(/continuation unavailable/i);
  expect(screen.getByText("Network fee")).toBeVisible();
  fireEvent.click(screen.getAllByRole("button", { name: /inspect transaction/i })[0]);
  expect(screen.getByText("Indexed executions")).toBeVisible();
  expect(screen.queryByRole("link", { name: /load more/i })).not.toBeInTheDocument();
  expect(data).toEqual(snapshot);
  expect(calls()).toHaveLength(1);
});
it("recovers fallback continuation manually without changing its cursor scope", async () => {
  const { data, calls, request } = continuationNetwork("activity", null);
  const window = { from: "2026-10-22T00:00:00Z" };
  render(<Activity address={DEMO_ADDRESS} window={window} cursor="grouped-old" />);
  expect(await screen.findByText("Balance-change feed")).toBeVisible();
  expect(await screen.findByRole("status", { name: "Activity continuation" })).toHaveTextContent(/continuation unavailable/i);
  expect(screen.queryByText("No observed transactions in this window")).not.toBeInTheDocument();
  expect(calls()).toHaveLength(1);
  expect(new URL(calls()[0][0], "http://test").searchParams.has("cursor")).toBe(false);
  data.cursor = "balance-next";
  fireEvent.click(screen.getByRole("button", { name: "Retry activity page" }));
  const next = new URL(
    (await screen.findByRole("link", { name: /load more/i })).getAttribute("href")!,
    "http://test",
  );
  expect(next.searchParams.get("source")).toBe("activity");
  expect(next.searchParams.get("cursor")).toBe("balance-next");
  expect(next.searchParams.get("from")).toBe(window.from);
  const newest = new URL(screen.getByRole("link", { name: "Newest activity" }).getAttribute("href")!, "http://test");
  expect(newest.searchParams.get("source")).toBe("activity");
  expect(newest.searchParams.has("cursor")).toBe(false);
  expect(calls()).toHaveLength(2);
  expect(request.mock.calls.filter(([input]) => new URL(input, "http://test").pathname.endsWith("/transactions"))).toHaveLength(1);
});
it("retains neutral balance-change observations with a blank continuation cursor", async () => {
  const { data, calls } = continuationNetwork("activity", "  ", false);
  const snapshot = structuredClone(data);
  render(<Activity address={DEMO_ADDRESS} source="activity" />);
  expect(await screen.findByText("Balance-change feed")).toBeVisible();
  expect(await screen.findByRole("status", { name: "Activity continuation" })).toHaveTextContent(/continuation unavailable/i);
  expect(screen.getAllByRole("button", { name: /inspect transaction/i }).length).toBeGreaterThan(0);
  expect(screen.queryByText("Observed executions")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /load more/i })).not.toBeInTheDocument();
  expect(data).toEqual(snapshot);
  expect(calls()).toHaveLength(1);
});
it("keeps an adequately covered empty seed distinct from unavailable continuation", async () => {
  const { data } = continuationNetwork("transactions", null);
  data.has_more = false;
  expect(validResourcePayload("transactions", data)).toBe(true);
  render(<Activity address={DEMO_ADDRESS} />);
  expect(await screen.findByText("No observed transactions in this window")).toBeVisible();
  expect(screen.queryByRole("status", { name: "Activity continuation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry activity page" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /load more/i })).not.toBeInTheDocument();
});
it.each(["transactions", "activity"] as const)(
  "scopes an empty terminal %s continuation to its page",
  async (source) => {
    const { data, calls } = continuationNetwork(source, null);
    data.has_more = false;
    expect(validResourcePayload(source, data)).toBe(true);
    const window = {
      from: "2026-10-22T00:00:00Z",
      to: "2026-10-23T00:00:00Z",
    };
    render(
      <Activity
        address={DEMO_ADDRESS}
        source={source}
        cursor="last-page"
        window={window}
      />,
    );
    expect(await screen.findByText("No matches on this page")).toBeVisible();
    expect(screen.queryByText("No observed transactions in this window")).not.toBeInTheDocument();
    const newest = new URL(
      screen.getByRole("link", { name: "Newest activity" }).getAttribute("href")!,
      "http://test",
    );
    expect(newest.searchParams.get("from")).toBe(window.from);
    expect(newest.searchParams.get("to")).toBe(window.to);
    expect(newest.searchParams.has("cursor")).toBe(false);
    expect(newest.searchParams.get("source")).toBe(source === "activity" ? "activity" : null);
    expect(screen.queryByRole("status", { name: "Activity continuation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /load more/i })).not.toBeInTheDocument();
    expect(calls()).toHaveLength(1);
  },
);

// This scrubbed fixture intentionally has no final newline: its bytes are pinned
// rather than a reserialized or prettified JSON reconstruction.
const recordedActivityBytes = readFileSync(
  new NodeURL("../../tests/fixtures/dmnd-source53-activity-not-indexed.json", import.meta.url),
);
const recordedActivity = JSON.parse(
  recordedActivityBytes.toString("utf8"),
) as ResourceData["activity"];
function activityCoverageNetwork(
  data: ResourceData["activity"],
  source: "activity" | "transactions" = "activity",
) {
  let payload: ResourceData["activity"] | ResourceData["transactions"] = data;
  if (source === "transactions") {
    const fixture = readFixture("transactions", "complete");
    if (!fixture.ok) throw new Error("Fixture must succeed");
    payload = {
      ...fixture.data,
      wallet: data.wallet,
      data: [],
      cursor: data.cursor,
      has_more: data.has_more,
      coverage: data.coverage,
    };
  }
  expect(validResourcePayload(source, payload)).toBe(true);
  const request = vi.fn(async (input: string) => {
    const url = new URL(input, "http://test");
    return url.pathname.endsWith("/" + source)
      ? Response.json({ ok: true, data: payload })
      : Response.json({ ok: false, kind: "configuration" });
  });
  vi.stubGlobal("fetch", request);
  return request;
}
function coverageValue(label: string) {
  return screen.getByText(label).nextElementSibling;
}
function expandActivityCoverage() {
  const summary = screen.getByText("About this activity").closest("summary")!;
  fireEvent.click(summary);
  expect(summary.parentElement).toHaveAttribute("open");
}
it("pins the scrubbed source53 activity fixture bytes and validates the payload", () => {
  expect(recordedActivityBytes.byteLength).toBe(332);
  expect(createHash("sha256").update(recordedActivityBytes).digest("hex")).toBe(
    "5ff62ce5b4a09894daa4d20826a124e3ea973fed4e37a90b339ee14c90ec02ae",
  );
  expect(recordedActivityBytes.at(-1)).not.toBe(10);
  expect(validResourcePayload("activity", recordedActivity)).toBe(true);
});
it("shows not-indexed activity from the scrubbed fixture as unknown with independent source facts", async () => {
  const data = structuredClone(recordedActivity);
  const snapshot = structuredClone(data);
  const request = activityCoverageNetwork(data);
  const { container } = render(<Activity address={data.wallet} source="activity" />);
  expect(await screen.findByText("No indexed activity is available yet")).toBeVisible();
  expect(screen.getByText("Partial history")).toBeVisible();
  expandActivityCoverage();
  expect(coverageValue("Token capture start slot")).toHaveTextContent(/^Unknown$/);
  expect(coverageValue("Token capture complete since start")).toHaveTextContent(/^Incomplete$/);
  expect(coverageValue("Token capture reason")).toHaveTextContent(/^not_indexed$/);
  expect(coverageValue("Native SOL capture start slot")).toHaveTextContent(/^Unknown$/);
  expect(coverageValue("Native SOL capture complete since start")).toHaveTextContent(/^Incomplete$/);
  expect(coverageValue("Native SOL capture reason")).toHaveTextContent(/^not_indexed$/);
  expect(coverageValue("First unindexed slot")).toHaveTextContent(/^Unknown$/);
  expect(coverageValue("Latest observed slot")).toHaveTextContent(/^337146264$/);
  expect(screen.queryByText("No observed transactions in this window")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /load more/i })).not.toBeInTheDocument();
  expect(container.querySelector("time")).toBeNull();
  expect(data).toEqual(snapshot);
  expect(request.mock.calls.filter(([input]) => new URL(input, "http://test").pathname.endsWith("/activity"))).toHaveLength(1);
});
it.each([
  ["activity", true],
  ["activity", false],
  ["transactions", true],
  ["transactions", false],
] as const)(
  "keeps independent %s capture facts when token completeness is %s",
  async (source, tokenComplete) => {
    // Synthetic causal controls deliberately distinguish token/native fields;
    // these variants are not additional recorded serving observations.
    const data = structuredClone(recordedActivity);
    data.coverage = {
      since_slot: tokenComplete ? 0 : 123,
      native_sol_since_slot: tokenComplete ? 456 : 0,
      live_slot: 999,
      first_unindexed_slot: null,
      complete_since_slot: tokenComplete,
      reason: tokenComplete ? "token_fixture_current" : "token_fixture_gap",
      native_sol_complete_since_slot: !tokenComplete,
      native_sol_reason: tokenComplete ? "native_fixture_token_filter" : "native_fixture_current",
    };
    const snapshot = structuredClone(data);
    activityCoverageNetwork(data, source);
    render(<Activity address={data.wallet} source={source} />);
    expect(await screen.findByText("No indexed activity is available yet")).toBeVisible();
    expect(screen.getByText("Partial history")).toBeVisible();
    expandActivityCoverage();
    expect(coverageValue("Token capture start slot")).toHaveTextContent(tokenComplete ? /^0$/ : /^123$/);
    expect(coverageValue("Native SOL capture start slot")).toHaveTextContent(tokenComplete ? /^456$/ : /^0$/);
    expect(coverageValue("Latest observed slot")).toHaveTextContent(/^999$/);
    expect(coverageValue("First unindexed slot")).toHaveTextContent(/^Unknown$/);
    expect(coverageValue("Token capture complete since start")).toHaveTextContent(tokenComplete ? /^Complete$/ : /^Incomplete$/);
    expect(coverageValue("Native SOL capture complete since start")).toHaveTextContent(tokenComplete ? /^Incomplete$/ : /^Complete$/);
    expect(coverageValue("Token capture reason")).toHaveTextContent(data.coverage.reason);
    expect(coverageValue("Native SOL capture reason")).toHaveTextContent(data.coverage.native_sol_reason);
    expect(data).toEqual(snapshot);
  },
);

it("distinguishes known zero source slots from absent capture facts", async () => {
  const data = structuredClone(recordedActivity);
  data.coverage = {
    since_slot: 0,
    native_sol_since_slot: 0,
    live_slot: 0,
    first_unindexed_slot: 0,
    complete_since_slot: false,
    reason: "fixture_token_gap",
    native_sol_complete_since_slot: false,
    native_sol_reason: "fixture_native_gap",
  };
  const snapshot = structuredClone(data);
  activityCoverageNetwork(data);
  render(<Activity address={data.wallet} source="activity" />);
  expect(await screen.findByText("No indexed activity is available yet")).toBeVisible();
  expandActivityCoverage();
  for (const label of [
    "Token capture start slot",
    "Native SOL capture start slot",
    "Latest observed slot",
    "First unindexed slot",
  ]) expect(coverageValue(label)).toHaveTextContent(/^0$/);
  expect(coverageValue("Token capture complete since start")).toHaveTextContent(/^Incomplete$/);
  expect(coverageValue("Native SOL capture complete since start")).toHaveTextContent(/^Incomplete$/);
  expect(coverageValue("Token capture reason")).toHaveTextContent(/^fixture_token_gap$/);
  expect(coverageValue("Native SOL capture reason")).toHaveTextContent(/^fixture_native_gap$/);
  expect(data).toEqual(snapshot);
});
