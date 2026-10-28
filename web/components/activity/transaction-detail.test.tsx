import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL as NodeURL } from "node:url";
import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TransactionDetail } from "./transaction-detail";
import { MINTS, readFixture } from "@/lib/fixtures/wallet";
import { Activity } from "./feed";
import type { ResourceData, Schemas } from "@/lib/dmnd/contracts";
import { validResourcePayload } from "@/lib/dmnd/validation.server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());

it("identifies the token in a transfer-only transaction even without balance changes", () => {
  const result = readFixture("transactions", "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  const row = { ...result.data.data[1], changes: [], change_count: 0 };
  render(<TransactionDetail row={row} labels={{ [MINTS.usdc]: "USDC" }} />);
  expect(screen.getByText(MINTS.usdc, { exact: true })).toBeVisible();
  expect(screen.getByText("USDC", { exact: true })).toBeVisible();
  expect(screen.getByText(/250,000,000 raw atoms/)).toBeVisible();
});

// Intentional no trailing newline in the fixture: this scrubbed positive-native
// body is pinned byte-for-byte, independently of JSON serialization conventions.
const positiveActivityBytes = readFileSync(
  new NodeURL("../../tests/fixtures/dmnd-source53-positive-native-activity.json", import.meta.url),
);
const positiveActivity = JSON.parse(
  positiveActivityBytes.toString("utf8"),
) as ResourceData["activity"];
function sourceValue(label: string) {
  return screen.getByText(label).nextElementSibling?.textContent;
}
async function inspectActivity(data: ResourceData["activity"]) {
  expect(validResourcePayload("activity", data)).toBe(true);
  const request = vi.fn(async (input: string) => {
    const url = new URL(input, "http://test");
    return url.pathname.endsWith("/activity")
      ? Response.json({ ok: true, data })
      : Response.json({ ok: false, kind: "configuration" });
  });
  vi.stubGlobal("fetch", request);
  const rendered = render(<Activity address={data.wallet} source="activity" />);
  const inspect = await screen.findByRole("button", { name: /inspect transaction/i });
  const compact = inspect.closest("tr")!.querySelector(".tx-amount")!;
  fireEvent.click(inspect);
  return { ...rendered, compact, request };
}
it("pins the scrubbed positive-native fixture bytes and its synthetic source wallet", () => {
  expect(positiveActivityBytes.byteLength).toBe(616);
  expect(createHash("sha256").update(positiveActivityBytes).digest("hex")).toBe(
    "c25d63fad3f046604ba607d9a02d335d66e505010a9d7e5d6e0a7c6d31f1183b",
  );
  expect(positiveActivityBytes.at(-1)).not.toBe(10);
  expect(positiveActivity.wallet).toBe("Fsx2Z8MEvG4DrBKq6mZBDaURMMKtPECjNKfeF15RfK4X");
  expect(validResourcePayload("activity", positiveActivity)).toBe(true);
});
it("preserves exact native source facts from the scrubbed fixture while keeping compact rounding", async () => {
  const data = structuredClone(positiveActivity);
  const snapshot = structuredClone(data);
  const { compact, container, request } = await inspectActivity(data);
  expect(compact).toHaveTextContent("+0.002377 SOL");
  expect(sourceValue("Observation kind")).toBe("native_sol_balance_change");
  expect(sourceValue("Raw delta (atoms)")).toBe("2376915");
  expect(sourceValue("Decimals")).toBe("9");
  expect(sourceValue("Source unit amount")).toBe("0.002376915");
  expect(sourceValue("Mint")).toBe("Native SOL (no mint)");
  expect(sourceValue("Transaction index")).toBe("41");
  expect(screen.getAllByText("Transaction index")).toHaveLength(1);
  expect(container.querySelector(".tx-detail")).toHaveTextContent("Slot 403121604");
  expect(container.querySelector(".tx-detail")).toHaveTextContent("2026-06-23T11:41:50.000Z");
  expect(screen.getByText(data.data[0].signature, { exact: true })).toBeVisible();
  expect(screen.getByText("Partial history")).toBeVisible();
  expect(screen.getByText(/Unknown — fee evidence was not supplied/)).toBeVisible();
  expect(screen.queryByText("Observed transfers")).not.toBeInTheDocument();
  expect(screen.queryByText("No indexed activity is available yet")).not.toBeInTheDocument();
  expect(container.querySelector(".tx-detail")).not.toHaveTextContent("WSOL");
  expect(data).toEqual(snapshot);
  const activityCalls = request.mock.calls.filter(([input]) => new URL(input, "http://test").pathname.endsWith("/activity"));
  expect(activityCalls).toHaveLength(1);
  for (const [input] of request.mock.calls)
    expect(new URL(input, "http://test").pathname).toContain(data.wallet);
});
const syntheticChanges: {
  label: string;
  change: Partial<Schemas["WalletActivityEntry"]>;
  index?: number;
  mint: string;
}[] = [
  {
    label: "negative native amount",
    change: { delta: "-2376915", ui_amount: "-0.002376915" },
    mint: "Native SOL (no mint)",
  },
  {
    label: "known zero token amount, decimals and index",
    change: { kind: "token_balance_change", mint: MINTS.usdc, delta: "0", ui_amount: "0", decimals: 0 },
    index: 0,
    mint: MINTS.usdc,
  },
  {
    label: "unknown native unit amount despite known decimals",
    change: { delta: "1", ui_amount: null, decimals: 9 },
    mint: "Native SOL (no mint)",
  },
  {
    label: "unknown token units and decimals",
    change: { kind: "token_balance_change", mint: MINTS.usdc, delta: "1000000", ui_amount: null, decimals: null },
    mint: MINTS.usdc,
  },
  {
    label: "known token mint and exact units",
    change: { kind: "token_balance_change", mint: MINTS.usdc, delta: "123456789", ui_amount: "123.456789", decimals: 6 },
    mint: MINTS.usdc,
  },
  {
    label: "very large exact native strings",
    change: { delta: "9".repeat(180) + "123456789", ui_amount: "9".repeat(180) + ".123456789", decimals: 9 },
    mint: "Native SOL (no mint)",
  },
  {
    label: "unknown token mint without native substitution",
    change: { kind: "token_balance_change", mint: null, delta: "17", ui_amount: null, decimals: null },
    mint: "Unknown",
  },
];
it.each(syntheticChanges)("retains $label as source text", async ({ change, index, mint }) => {
  // Causal presentation controls only; these are not additional live observations.
  const data = structuredClone(positiveActivity);
  Object.assign(data.data[0], change);
  if (index !== undefined) data.data[0].transaction_index = index;
  const snapshot = structuredClone(data);
  const { compact } = await inspectActivity(data);
  const entry = data.data[0];
  expect(sourceValue("Observation kind")).toBe(entry.kind);
  expect(sourceValue("Raw delta (atoms)")).toBe(entry.delta);
  expect(sourceValue("Decimals")).toBe(entry.decimals == null ? "Unknown" : String(entry.decimals));
  expect(sourceValue("Source unit amount")).toBe(entry.ui_amount ?? "Unknown");
  expect(sourceValue("Mint")).toBe(mint);
  expect(sourceValue("Transaction index")).toBe(String(entry.transaction_index));
  if (entry.kind === "token_balance_change" && entry.mint === null) {
    expect(compact).toHaveTextContent("Unknown asset");
    expect(compact).not.toHaveTextContent("SOL");
  }
  expect(data).toEqual(snapshot);
});
