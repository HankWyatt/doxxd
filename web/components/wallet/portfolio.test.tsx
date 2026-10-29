import { act, cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Portfolio } from "./portfolio";
import { readFixture, DEMO_ADDRESS } from "@/lib/fixtures/wallet";
import type { ResourceName } from "@/lib/dmnd/contracts";
import { validResourcePayload } from "@/lib/dmnd/validation.server";
import { protocolResources } from "@/lib/dmnd/resources";
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function network(summaryError = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://doxxd.test");
      const resource = url.pathname.split("/").at(-1) as ResourceName;
      return new Response(
        JSON.stringify(
          summaryError && resource === "summary"
            ? { ok: false, kind: "configuration" }
            : readFixture(resource, "protocol-error"),
        ),
      );
    }),
  );
}
it("shows holdings and protocol detail without changing the authoritative headline", async () => {
  network();
  render(<Portfolio address={DEMO_ADDRESS} />);
  expect(await screen.findByText("$12,345.67")).toBeVisible();
  expect(await screen.findByText("USD Coin")).toBeVisible();
  // Protocol cards are open by default.
  expect(await screen.findByText("Lending position")).toBeVisible();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});
it("keeps holdings usable when the summary fails", async () => {
  network(true);
  render(<Portfolio address={DEMO_ADDRESS} />);
  expect(await screen.findByText("USD Coin")).toBeVisible();
  expect(await screen.findByText("Data connection unavailable")).toBeVisible();
});
it("isolates a protocol failure from the rest of the wallet", async () => {
  network();
  render(<Portfolio address={DEMO_ADDRESS} />);
  await screen.findByText("$12,345.67");
  expect(await screen.findByText("Couldn’t load this section")).toBeVisible();
  expect(screen.getByText("USD Coin")).toBeVisible();
});

it("mounts summary navigation targets even when a component is excluded from the known total", async () => {
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, "http://doxxd.test");
    const resource = url.pathname.split("/").at(-1) as ResourceName;
    const result = readFixture(resource, "complete");
    if (resource === "summary" && result.ok) {
      const summary = readFixture("summary", "complete");
      if (!summary.ok) throw Error("fixture");
      summary.data.components.push({
        ...summary.data.components[1],
        id: "liquid_staking_receipts",
        source_path: "liquid-staking",
        known_asset_value_usd: "1650",
        known_debt_value_usd: "0",
        known_net_value_usd: "1650",
        included_in_known_total: false,
        reason: "direct_receipt_overlap",
      });
      expect(validResourcePayload("summary", summary.data)).toBe(true);
      return Response.json(summary);
    }
    return Response.json(result);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<Portfolio address={DEMO_ADDRESS} />);
  const reference = await screen.findByRole("link", { name: /Liquid staking/ });
  expect(reference).toHaveAttribute("href", "#protocol-liquid-staking");
  expect(document.getElementById("protocol-liquid-staking")).not.toBeNull();
  // An excluded component with a value still gets an open card.
  expect(screen.getByRole("button", { name: "Collapse Liquid staking" }))
    .toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("$12,345.67")).toBeVisible();
  // Summary, overview and trading, plus one request per card, once every card
  // has rendered its loaded page.
  for (const id of ["stake", "kamino", "orca", "liquid-staking"])
    expect(await within(document.getElementById("protocol-" + id)!).findByRole("table")).toBeVisible();
  const read = (resource: string) =>
    fetcher.mock.calls.filter(([input]) => new URL(input, "http://doxxd.test").pathname.endsWith("/" + resource)).length;
  for (const resource of ["summary", "overview", "positions", "stake", "kamino", "orca", "liquid-staking"])
    expect(read(resource), resource).toBe(1);
  expect(fetcher.mock.calls).toHaveLength(7);
});

it("keeps a pending zero subtotal separate from positive holdings until the summary includes wallet balances", async () => {
  vi.useFakeTimers();
  let summaries = 0;
  const fetcher = vi.fn(async (input: string) => {
    const resource = new URL(input, "http://doxxd.test").pathname.split("/").at(-1) as ResourceName;
    if (resource === "summary") {
      const result = readFixture("summary", "complete");
      if (!result.ok) throw Error("fixture");
      summaries++;
      result.data.known_component_net_value_usd = summaries === 1 ? "0" : "123.45";
      Object.assign(result.data.components[0], summaries === 1 ? {
        included_in_known_total: false,
        known_net_value_usd: null,
        coverage_status: "snapshot_queued",
        coverage_complete: false,
        coverage_fresh: false,
      } : { known_net_value_usd: "123.45" });
      for (const component of result.data.components.slice(1)) {
        component.known_asset_value_usd = "0";
        component.known_debt_value_usd = "0";
        component.known_net_value_usd = "0";
      }
      return Response.json(result);
    }
    if (resource === "positions") return Response.json(readFixture("positions", "complete"));
    const result = readFixture("overview", "complete");
    if (!result.ok) throw Error("fixture");
    result.data.known_value_usd = "318.47";
    return Response.json(result);
  });
  vi.stubGlobal("fetch", fetcher);
  const { container } = render(<Portfolio address={DEMO_ADDRESS} />);
  await act(async () => {});
  expect(container.querySelector("#holdings .holdings-total"))
    .toHaveTextContent("$318.47 known");
  expect(screen.getByText("Wallet balances unavailable · showing protocols only")).toHaveAttribute("data-tone", "pending");
  expect(container.querySelector(".summary-value")).toHaveTextContent("$0.00");
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.filter(([input]) => input.endsWith("/overview"))).toHaveLength(1);

  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(container.querySelector(".summary-value")).toHaveTextContent("$123.45");
  expect(screen.getByText("Known value")).toBeVisible();
  expect(screen.queryByText("Wallet balances unavailable · showing protocols only")).not.toBeInTheDocument();
  expect(container.querySelector("#holdings .holdings-total"))
    .toHaveTextContent("$318.47 known");
  await act(async () => { await vi.advanceTimersByTimeAsync(150_000); });
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.calls.filter(([input]) => input.endsWith("/overview"))).toHaveLength(1);
});

it("keeps holdings and the subtotal usable after snapshot failure, then stops automatic reads", async () => {
  vi.useFakeTimers();
  const counts = new Map<string, number>();
  const fetcher = vi.fn(async (input: string) => {
    const resource = new URL(input, "http://doxxd.test").pathname.split("/").at(-1) as ResourceName;
    const count = (counts.get(resource) ?? 0) + 1;
    counts.set(resource, count);
    if (resource === "summary") {
      const result = readFixture("summary", "complete");
      if (!result.ok) throw Error("fixture");
      result.data.known_component_net_value_usd = "0";
      Object.assign(result.data.components[0], {
        included_in_known_total: false,
        known_net_value_usd: null,
        coverage_status: count === 1 ? "snapshot_queued" : "native_balance_stale_or_unavailable",
        coverage_complete: false,
        coverage_fresh: false,
      });
      for (const component of result.data.components.slice(1)) {
        component.known_asset_value_usd = "0";
        component.known_debt_value_usd = "0";
        component.known_net_value_usd = "0";
      }
      return Response.json(result);
    }
    if (resource === "positions") return Response.json(readFixture("positions", "complete"));
    const result = readFixture("overview", "complete");
    if (!result.ok) throw Error("fixture");
    Object.assign(result.data, {
      known_value_usd: "318.47",
      native_sol_lamports: null,
      wrapped_sol_lamports: null,
    });
    Object.assign(result.data.coverage, {
      complete: false,
      snapshot_status: count === 1 ? "queued" : "failed",
    });
    return Response.json(result);
  });
  vi.stubGlobal("fetch", fetcher);
  const { container } = render(<Portfolio address={DEMO_ADDRESS} />);
  await act(async () => {});
  expect(screen.getByText("Wallet balances unavailable · showing protocols only")).toHaveAttribute("data-tone", "pending");
  expect(fetcher).toHaveBeenCalledTimes(3);

  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText("Wallet balances unavailable · showing protocols only")).toHaveAttribute("data-tone", "partial");
  expect(container.querySelector(".summary-value")).toHaveTextContent("$0.00");
  expect(container.querySelector("#holdings .holdings-total"))
    .toHaveTextContent("$318.47 known");
  expect(screen.getByText("Wallet refresh failed. Showing available holdings; some balances may be missing or out of date.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Inspect USDC holding" })).toBeVisible();
  expect(screen.getByText("Native SOL balance: Unknown")).toBeVisible();
  expect(screen.getByText("Wrapped SOL balance: Unknown")).toBeVisible();
  expect(screen.queryByText(/sources? still updating/)).not.toBeInTheDocument();
  expect(screen.queryByText("Checking for wallet data automatically…")).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(5);
  await act(async () => { await vi.advanceTimersByTimeAsync(150_000); });
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(counts.get("overview")).toBe(2);
  expect(counts.get("summary")).toBe(2);
  expect(counts.get("positions")).toBe(1);
});

it("renders holdings without waiting for trading details and isolates their failure", async () => {
  let finish!: (response: Response) => void;
  const positions = new Promise<Response>(resolve => { finish = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const resource = new URL(input, "http://doxxd.test").pathname.split("/").at(-1) as ResourceName;
    return resource === "positions" ? positions : Response.json(readFixture(resource, "complete"));
  }));
  render(<Portfolio address={DEMO_ADDRESS} />);
  expect(await screen.findByText("USD Coin")).toBeVisible();
  expect(screen.getByText("Loading indexed trading details…", { exact: false })).toBeVisible();
  expect(screen.getByText("$12,345.67")).toBeVisible();
  await act(async () => finish(Response.json({ ok: false, kind: "unavailable" })));
  expect(screen.getByText("Trading details couldn’t load. Available holdings remain visible.")).toBeVisible();
  expect(screen.getByText("USD Coin")).toBeVisible();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});

it("shows chips only for sources with something, and summarises the rest", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const resource = new URL(input, "http://doxxd.test").pathname.split("/").at(-1) as ResourceName;
    if (resource === "summary") {
      const result = readFixture("summary", "complete");
      if (!result.ok) throw Error("fixture");
      const { components } = result.data;
      const set = (id: string, value: string, extra = {}) =>
        Object.assign(components.find((c) => c.id === id)!, {
          known_asset_value_usd: value,
          known_debt_value_usd: "0",
          known_net_value_usd: value,
        }, extra);
      for (const c of components) set(c.id, "0");
      set("tokens_native_sol", "31.07");
      set("kamino_lend", "400");
      set("native_stake", "0", { coverage_status: "disabled", reason: "disabled" });
      result.data.known_component_net_value_usd = "431.07";
      expect(validResourcePayload("summary", result.data)).toBe(true);
      return Response.json(result);
    }
    return Response.json(readFixture(resource, "complete"));
  }));
  render(<Portfolio address={DEMO_ADDRESS} />);
  const strip = await screen.findByLabelText("Portfolio sources");
  const links = Array.from(strip.querySelectorAll("a"));
  expect(links.map((a) => a.getAttribute("href"))).toEqual(["#protocol-kamino", "#holdings"]);
  expect(links[0]).toHaveTextContent("$400.00");
  expect(links[1]).toHaveTextContent("$31.07");
  expect(strip).toHaveTextContent("+1 protocol checked · nothing found");
  expect(strip).toHaveTextContent("1 not available yet");
});

function chipSummary(fetcher: (resource: ResourceName, url: URL) => Response | undefined) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input, "http://doxxd.test");
    const resource = url.pathname.split("/").at(-1) as ResourceName;
    calls.push(resource);
    const custom = fetcher(resource, url);
    if (custom) return custom;
    if (resource === "summary") {
      const result = readFixture("summary", "complete");
      if (!result.ok) throw Error("fixture");
      for (const c of result.data.components)
        Object.assign(c, {
          known_asset_value_usd: "0",
          known_debt_value_usd: "0",
          known_net_value_usd: "0",
        });
      Object.assign(result.data.components.find((c) => c.id === "tokens_native_sol")!, {
        known_asset_value_usd: "31.07",
        known_net_value_usd: "31.07",
      });
      Object.assign(result.data.components.find((c) => c.id === "kamino_lend")!, {
        known_asset_value_usd: "400",
        known_net_value_usd: "400",
      });
      result.data.known_component_net_value_usd = "431.07";
      expect(validResourcePayload("summary", result.data)).toBe(true);
      return Response.json(result);
    }
    return Response.json(readFixture(resource, "complete"));
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

it("cards render only for chip protocols, open, and fetch on mount", async () => {
  const calls = chipSummary(() => undefined);
  const { container } = render(<Portfolio address={DEMO_ADDRESS} />);
  const toggle = await screen.findByRole("button", { name: "Collapse Kamino Lend" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(toggle).toHaveClass("protocol-toggle");
  expect(await within(container.querySelector<HTMLElement>("#protocol-kamino")!).findByText("Lending position")).toBeVisible();
  expect(container.querySelectorAll("section[id^='protocol-']")).toHaveLength(1);
  expect(document.getElementById("protocol-orca")).toBeNull();
  expect(document.getElementById("protocol-stake")).toBeNull();
  expect(screen.queryByText(/Additional protocol views/)).toBeNull();
  expect(screen.getByText("1 protocol")).toBeVisible();
  // One request per rendered card, none for protocols without a chip.
  expect(calls.filter((r) => r === "kamino")).toHaveLength(1);
  expect(calls.slice().sort()).toEqual(["kamino", "overview", "positions", "summary"]);
});

it("failed card shows retry not zero", async () => {
  let orcaReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const resource = new URL(input, "http://doxxd.test").pathname.split("/").at(-1) as ResourceName;
    if (resource === "orca" && ++orcaReads === 1) return Response.json({ ok: false, kind: "upstream" });
    return Response.json(readFixture(resource, "complete"));
  }));
  const { container } = render(<Portfolio address={DEMO_ADDRESS} />);
  const orca = () => {
    const section = container.querySelector<HTMLElement>("#protocol-orca");
    if (!section) throw Error("orca card not mounted");
    return section;
  };
  expect(await within(await waitFor(orca)).findByText("Couldn’t load this section")).toBeVisible();
  expect(orca().querySelector(".protocol-value")).toHaveTextContent("—");
  expect(within(orca()).queryByText("$0.00")).toBeNull();
  const note = screen.getByText(/couldn’t load ·/);
  expect(note).toHaveTextContent("1 protocol couldn’t load · retry");
  fireEvent.click(within(note).getByRole("button", { name: "retry" }));
  expect(await within(orca()).findByRole("table")).toBeVisible();
  expect(orca().querySelector(".protocol-value")).toHaveTextContent("$1,645.67");
  expect(screen.queryByText(/couldn’t load ·/)).toBeNull();
  expect(orcaReads).toBe(2);
});

it("renders every protocol card collapsed and lazy when the summary is unavailable", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const resource = new URL(input, "http://doxxd.test").pathname.split("/").at(-1) as ResourceName;
    calls.push(resource);
    if (resource === "summary") return Response.json({ ok: false, kind: "unavailable" });
    return Response.json(readFixture(resource, "complete"));
  }));
  const { container } = render(<Portfolio address={DEMO_ADDRESS} />);
  expect(await screen.findByText("Portfolio summary unavailable — open a protocol to check it.")).toBeVisible();
  await screen.findByText("USD Coin");
  const toggles = container.querySelectorAll<HTMLElement>(".protocol-toggle");
  expect(toggles).toHaveLength(protocolResources.length);
  for (const toggle of toggles) expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(calls.slice().sort()).toEqual(["overview", "positions", "summary"]);
  fireEvent.click(screen.getByRole("button", { name: "Expand Kamino Lend" }));
  expect(await screen.findByText("Lending position")).toBeVisible();
  expect(calls.filter((r) => r === "kamino")).toHaveLength(1);
  expect(calls).toHaveLength(4);
});

it("treats a summary with no components like an unavailable summary", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const resource = new URL(input, "http://doxxd.test").pathname.split("/").at(-1) as ResourceName;
    const result = readFixture(resource, "complete");
    if (resource === "summary" && result.ok && "components" in result.data) {
      result.data.components = [];
      result.data.known_component_net_value_usd = null;
    }
    return Response.json(result);
  }));
  const { container } = render(<Portfolio address={DEMO_ADDRESS} />);
  expect(await screen.findByText("Portfolio summary unavailable — open a protocol to check it.")).toBeVisible();
  expect(container.querySelectorAll(".protocol-toggle")).toHaveLength(protocolResources.length);
  expect(container.querySelector(".protocol-toggle[aria-expanded='true']")).toBeNull();
});

it("keeps a collapsed failed card counted until it loads", async () => {
  let orcaReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const resource = new URL(input, "http://doxxd.test").pathname.split("/").at(-1) as ResourceName;
    if (resource === "orca" && ++orcaReads === 1) return Response.json({ ok: false, kind: "upstream" });
    return Response.json(readFixture(resource, "complete"));
  }));
  const { container } = render(<Portfolio address={DEMO_ADDRESS} />);
  expect(await screen.findByText("Couldn’t load this section")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Collapse Orca Whirlpools" }));
  const orca = container.querySelector<HTMLElement>("#protocol-orca")!;
  expect(within(orca).queryByText("Couldn’t load this section")).toBeNull();
  expect(orca.querySelector(".protocol-value")).toHaveTextContent(/^—$/);
  const note = screen.getByText(/couldn’t load ·/);
  expect(note).toHaveTextContent("1 protocol couldn’t load · retry");
  // Retrying a collapsed card opens it and loads it again.
  fireEvent.click(within(note).getByRole("button", { name: "retry" }));
  expect(await within(orca).findByRole("table")).toBeVisible();
  expect(screen.getByRole("button", { name: "Collapse Orca Whirlpools" })).toBeVisible();
  expect(orca.querySelector(".protocol-value")).toHaveTextContent("$1,645.67");
  expect(screen.queryByText(/couldn’t load ·/)).toBeNull();
  expect(orcaReads).toBe(2);
});
