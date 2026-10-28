import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProtocolSection } from "./protocol-section";
import { DEMO_ADDRESS, readFixture } from "@/lib/fixtures/wallet";
import { validResourcePayload } from "@/lib/dmnd/validation.server";

afterEach(() => vi.unstubAllGlobals());
it("can return to the seed when a snapshot-bound position cursor expires", async () => {
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input, "http://test");
    if (url.searchParams.has("cursor"))
      return Response.json(
        { ok: false, kind: "invalid_input" },
        { status: 400 },
      );
    const result = readFixture("orca", "complete");
    if (!result.ok) throw new Error("Fixture must succeed");
    result.data.has_more = true;
    result.data.cursor = "expired";
    return Response.json(result);
  });
  render(
    <ProtocolSection
      address={DEMO_ADDRESS}
      resource="orca"
      mode={{ kind: "live" }}
      labels={{}}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Expand Orca Whirlpools" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Next positions" }),
  );
  expect(
    await screen.findByText("This request couldn’t be completed"),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "First page" }));
  expect(
    await screen.findByRole("button", { name: "Next positions" }),
  ).toBeVisible();
});

function orcaPage() {
  const result = readFixture("orca", "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  return result.data;
}
function renderOrca() {
  render(
    <ProtocolSection
      address={DEMO_ADDRESS}
      resource="orca"
      mode={{ kind: "live" }}
      labels={{}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand Orca Whirlpools" }));
}
function protocolResponse(data: ReturnType<typeof orcaPage>) {
  expect(validResourcePayload("orca", data)).toBe(true);
  return Response.json({ ok: true, data });
}

it("labels an empty seed page as page-scoped when the snapshot reports positions", async () => {
  const data = orcaPage();
  data.data = [];
  data.coverage.total_positions = 3;
  data.page_known_principal_value_usd = "0";
  const fetch = vi.fn(async () => protocolResponse(data));
  vi.stubGlobal("fetch", fetch);
  renderOrca();
  expect(await screen.findByText("No positions on this page")).toBeVisible();
  expect(screen.queryByText("No positions were found in this supported scope.")).toBeNull();
  expect(screen.getByText("Source snapshot positions: 3.")).toBeInTheDocument();
  expect(screen.getByText("Current snapshot")).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not label a terminal continuation as an empty scope and can return to the first page", async () => {
  const opaqueCursor = "opaque:+/cursor";
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input, "http://test");
    const data = orcaPage();
    if (url.searchParams.has("cursor")) {
      expect(url.searchParams.get("cursor")).toBe(opaqueCursor);
      data.data = [];
      data.coverage.total_positions = 0;
      data.page_known_principal_value_usd = "0";
    } else {
      data.has_more = true;
      data.cursor = opaqueCursor;
    }
    return protocolResponse(data);
  });
  vi.stubGlobal("fetch", fetch);
  renderOrca();
  fireEvent.click(await screen.findByRole("button", { name: "Next positions" }));
  expect(await screen.findByText("No positions on this page")).toBeVisible();
  expect(screen.queryByText("No positions were found in this supported scope.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Next positions" })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "First page" }));
  expect(await screen.findByRole("table")).toBeVisible();
  expect(await screen.findByRole("button", { name: "Next positions" })).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("keeps continuation available from an empty intermediate page", async () => {
  const opaqueCursor = "next:+/cursor";
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input, "http://test");
    const data = orcaPage();
    if (!url.searchParams.has("cursor")) {
      data.data = [];
      data.has_more = true;
      data.cursor = opaqueCursor;
      data.page_known_principal_value_usd = "0";
    } else expect(url.searchParams.get("cursor")).toBe(opaqueCursor);
    return protocolResponse(data);
  });
  vi.stubGlobal("fetch", fetch);
  renderOrca();
  expect(await screen.findByRole("button", { name: "Next positions" })).toBeVisible();
  expect(screen.queryByText("No positions were found in this supported scope.")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Next positions" }));
  expect(await screen.findByRole("table")).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([null, " \t "])(
  "preserves rows and retries a page manually when its continuation cursor is unusable: %j",
  async (cursor) => {
    let attempts = 0;
    const fetch = vi.fn(async () => {
      const data = orcaPage();
      attempts++;
      if (attempts === 1) {
        data.has_more = true;
        data.cursor = cursor;
      }
      return protocolResponse(data);
    });
    vi.stubGlobal("fetch", fetch);
    renderOrca();
    const retry = await screen.findByRole("button", { name: "Retry positions page" });
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByText(/More positions are reported, but the continuation cursor is unavailable/)).toBeVisible();
    expect(screen.getByText("This page: $1,645.67")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Next positions" })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    expect(await screen.findByText("Current snapshot")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry positions page" })).toBeNull();
    expect(screen.getByRole("table")).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it("does not claim scope emptiness when an empty page has unavailable continuation", async () => {
  const data = orcaPage();
  data.data = [];
  data.has_more = true;
  data.cursor = null;
  data.page_known_principal_value_usd = "0";
  const fetch = vi.fn(async () => protocolResponse(data));
  vi.stubGlobal("fetch", fetch);
  renderOrca();
  expect(await screen.findByRole("button", { name: "Retry positions page" })).toBeVisible();
  expect(screen.queryByText("No positions were found in this supported scope.")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("retains scope-empty wording for an adequately covered empty first page", async () => {
  const data = orcaPage();
  data.data = [];
  data.coverage.total_positions = 0;
  data.page_known_principal_value_usd = "0";
  vi.stubGlobal("fetch", async () => protocolResponse(data));
  renderOrca();
  expect(await screen.findByText("No positions were found in this supported scope.")).toBeVisible();
  expect(screen.queryByText("No positions on this page")).toBeNull();
});

it("renders non-liquidity rows safely when coverage contains an unrecognized inventory extension", async () => {
  const result = readFixture("stake", "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  const data = {
    ...result.data,
    coverage: {
      ...result.data.coverage,
      total_positions: { unexpected: "value" },
    },
  };
  expect(validResourcePayload("stake", data)).toBe(true);
  vi.stubGlobal("fetch", async () => Response.json({ ok: true, data }));
  render(
    <ProtocolSection
      address={DEMO_ADDRESS}
      resource="stake"
      mode={{ kind: "live" }}
      labels={{}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand Native staking" }));
  expect(await screen.findByRole("table")).toBeVisible();
  expect(screen.queryByText(/Source snapshot positions:/)).toBeNull();
});

it("keeps liquid receipt rows when unpaged payloads contain pagination extensions", async () => {
  const result = readFixture("liquid-staking", "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  const data = {
    ...result.data,
    has_more: true,
    cursor: { unrelated: "extension" },
  };
  expect(validResourcePayload("liquid-staking", data)).toBe(true);
  const fetch = vi.fn(async () => Response.json({ ok: true, data }));
  vi.stubGlobal("fetch", fetch);
  render(
    <ProtocolSection
      address={DEMO_ADDRESS}
      resource="liquid-staking"
      mode={{ kind: "live" }}
      labels={{}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand Liquid staking" }));
  expect(await screen.findByRole("table")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Next positions" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry positions page" })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
