import { expect, it } from "vitest";
import { toProtocolView } from "./model";
import { tokenLabels } from "./adapters/shared";
import { readFixture } from "@/lib/fixtures/wallet";
import { CLMM, clmmPage } from "@/tests/fixtures/synthetic-raydium-positions";
import { dammV2Page } from "@/tests/fixtures/synthetic-meteora-damm-v2";

const WSOL = "So11111111111111111111111111111111111111112";
const IMAGE = "https://tokens.example.com/synr.png";

it("keeps DMND's trimmed token labels, and none for wrapped SOL or a missing mint", () => {
  expect(
    tokenLabels({ mint: CLMM.reward, symbol: " SYNR ", name: " Reward ", image_url: IMAGE }),
  ).toEqual({ symbol: "SYNR", name: "Reward", image: IMAGE });
  expect(tokenLabels({ mint: CLMM.reward, symbol: " ", name: null, image_url: null })).toEqual({});
  expect(tokenLabels({ mint: WSOL, symbol: "WSOL", image_url: IMAGE })).toEqual({});
  expect(tokenLabels({ mint: null, symbol: "SYNR" })).toEqual({});
});

it("carries leg and reward labels onto the view, with each mint in its details", () => {
  const page = clmmPage();
  Object.assign(page.data[0].principal_a, { name: "Synthetic A", image_url: IMAGE });
  page.data[0].rewards = [{ mint: CLMM.reward, owed_atoms: "1", symbol: "SYNR" }];
  const row = toProtocolView({ resource: "raydium-clmm", data: page }).positions[0];
  expect(row.assets[0]).toMatchObject({ label: "SYNA", symbol: "SYNA", name: "Synthetic A", image: IMAGE });
  expect(row.rewards[0]).toMatchObject({ label: "SYNR", symbol: "SYNR", mint: CLMM.reward });
  expect(row.rewards[0].sourceDetails).toContainEqual({ label: "Mint", value: CLMM.reward });
});

it("labels DAMM v2 fees and rewards from their own token labels", () => {
  const page = dammV2Page();
  const position = page.data[0];
  position.token_b.image_url = IMAGE;
  position.rewards = [
    { index: 0, mint: CLMM.reward, claimable_atoms: "1", decimals: 0, symbol: "SYNR" },
  ];
  const row = toProtocolView({ resource: "meteora-damm-v2", data: page }).positions[0];
  expect(row.fees?.[1]).toMatchObject({ mint: position.token_b.mint, image: IMAGE });
  expect(row.fees?.[1].sourceDetails).toContainEqual({ label: "Mint", value: position.token_b.mint });
  expect(row.rewards.at(-1)).toMatchObject({ label: "SYNR", symbol: "SYNR" });
});

it("reads wrapped SOL as SOL in lending legs", () => {
  const result = readFixture("kamino", "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  const deposit = result.data.data[0].deposits[0];
  deposit.mint = WSOL;
  const view = toProtocolView({ resource: "kamino", data: result.data });
  expect(view.positions[0].assets[0]).toMatchObject({ mint: WSOL, label: "SOL" });
});
