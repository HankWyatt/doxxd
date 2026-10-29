import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schemas } from "@/lib/dmnd/contracts";
import {
  DAMM,
  dammV2Page,
  syntheticAddress,
} from "@/tests/fixtures/synthetic-meteora-damm-v2";
import { loadAllPages } from "./load-all-pages";
import { ACTION_PROGRAM_IDS } from "./types";

afterEach(() => vi.unstubAllGlobals());

// One synthetic DAMM v2 page holding position `n`, continuing to `next`.
function page(n: number, next: string | null): Schemas["WalletMeteoraDammV2Positions"] {
  const p = dammV2Page();
  p.data[0].position = syntheticAddress("damm-v2/load-all/" + n);
  p.data[0].program = ACTION_PROGRAM_IDS["meteora-damm-v2"];
  p.cursor = next;
  p.has_more = next !== null;
  return p;
}

function serve(pages: Record<string, unknown>) {
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input, "http://doxxd.test");
    const body = pages[url.searchParams.get("cursor") ?? ""];
    return body === undefined
      ? Response.json({ ok: false, kind: "upstream" }, { status: 502 })
      : Response.json(body);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const base = `/api/wallet/${DAMM.wallet}/meteora-damm-v2?limit=50`;

describe("loadAllPages", () => {
  it("follows 3 cursors from the loaded first page and maps every row", async () => {
    const fetch = serve({
      c1: { ok: true, data: page(2, "c2") },
      c2: { ok: true, data: page(3, "c3") },
      c3: { ok: true, data: page(4, null) },
    });
    const targets = await loadAllPages(DAMM.wallet, "meteora-damm-v2", page(1, "c1"));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      base + "&cursor=c1",
      base + "&cursor=c2",
      base + "&cursor=c3",
    ]);
    expect(targets.map((t) => t.id)).toEqual(
      [1, 2, 3, 4].map((n) => syntheticAddress("damm-v2/load-all/" + n)),
    );
    expect(targets.every((t) => t.protocol === "meteora-damm-v2")).toBe(true);
  });

  it("fetches the first page itself when none is loaded", async () => {
    const fetch = serve({ "": { ok: true, data: page(1, "c1") }, c1: { ok: true, data: page(2, null) } });
    const targets = await loadAllPages(DAMM.wallet, "meteora-damm-v2", null);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([base, base + "&cursor=c1"]);
    expect(targets).toHaveLength(2);
  });

  it("keeps only rows that carry an action target, without repeats", async () => {
    const other = page(2, null);
    other.data.push({ ...page(1, null).data[0] });
    other.data.push({ ...page(3, null).data[0], program: syntheticAddress("not-cp-amm") });
    serve({ c1: { ok: true, data: other } });
    const targets = await loadAllPages(DAMM.wallet, "meteora-damm-v2", page(1, "c1"));
    expect(targets.map((t) => t.id)).toEqual(
      [1, 2].map((n) => syntheticAddress("damm-v2/load-all/" + n)),
    );
  });

  it("fails rather than return part of the positions", async () => {
    serve({ c1: { ok: true, data: page(2, "c2") } });
    await expect(loadAllPages(DAMM.wallet, "meteora-damm-v2", page(1, "c1"))).rejects.toThrow();
  });

  it("fails on another wallet's page, a missing cursor or a repeated cursor", async () => {
    const foreign = page(2, null);
    foreign.wallet = syntheticAddress("someone-else");
    serve({ c1: { ok: true, data: foreign } });
    await expect(loadAllPages(DAMM.wallet, "meteora-damm-v2", page(1, "c1"))).rejects.toThrow();

    const noCursor = page(2, null);
    noCursor.has_more = true;
    serve({ c1: { ok: true, data: noCursor } });
    await expect(loadAllPages(DAMM.wallet, "meteora-damm-v2", page(1, "c1"))).rejects.toThrow();

    serve({ c1: { ok: true, data: page(2, "c1") } });
    await expect(loadAllPages(DAMM.wallet, "meteora-damm-v2", page(1, "c1"))).rejects.toThrow();
  });
});
