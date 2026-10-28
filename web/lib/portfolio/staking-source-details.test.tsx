import { render, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { Amounts, PositionDetail } from "@/components/wallet/position-detail";
import type { Schemas } from "../dmnd/contracts";
import { validResourcePayload } from "../dmnd/validation.server";
import { toProtocolView } from "./model";

const zeroPublicKey = "11111111111111111111111111111111";
const maxU64Epoch = "18446744073709551615";
const basis =
  "Total account lamports include rent reserve and undelegated excess. Delegated lamports are raw delegation, not effective or withdrawable stake.";

// Synthetic source-shaped data only: this is not positive production evidence.
// Includes every pinned WalletStakeAccounts/WalletStakeAccount field. The API
// can return stored rows while stake_scan_disabled keeps coverage incomplete.
// USD fields are independent authority sentinels for verbatim retention, not a
// financially coherent price/value fixture or a pricing regression test.
function syntheticStoredStake(
  overrides: Partial<Schemas["WalletStakeAccount"]> = {},
): Schemas["WalletStakeAccounts"] {
  return {
    wallet: zeroPublicKey,
    data: [
      {
        stake_account: "synthetic-stake-account",
        snapshot_slot: 123,
        lamports: "18446744073709551615",
        rent_exempt_reserve: "2282880",
        state: "delegated",
        staker: "synthetic-staker",
        withdrawer: zeroPublicKey,
        lockup_unix_timestamp: -1,
        lockup_epoch: maxU64Epoch,
        lockup_custodian: "synthetic-custodian",
        vote_account: "synthetic-vote-account",
        delegated_lamports: "9007199254740993",
        activation_epoch: "9007199254740993",
        deactivation_epoch: maxU64Epoch,
        value_usd: "123.456789",
        ...overrides,
      },
    ],
    cursor: null,
    has_more: false,
    total_lamports: overrides.lamports ?? "18446744073709551615",
    sol_price_usd: "150",
    sol_price_updated_at: "2026-10-23T20:00:00Z",
    known_stake_value_usd: "123.456789",
    coverage: {
      complete: false,
      fresh: true,
      status: "complete",
      reason: "stake_scan_disabled",
      requested_at: "2026-10-23T20:00:00Z",
      fetched_at: "2026-10-23T20:00:01Z",
      snapshot_slot: 124,
      scope: "native_stake_program_withdrawer",
    },
  };
}

function expectDetail(container: HTMLElement, label: string, value: string) {
  const term = within(container).getByText(label, {
    exact: true,
    selector: "dt",
  });
  const description = term.nextElementSibling;
  expect(description?.tagName).toBe("DD");
  expect(description?.textContent).toBe(value);
  expect(description).toBeVisible();
}

it("retains stored native stake facts and partial coverage with a disabled scanner", () => {
  const data = syntheticStoredStake();
  expect(validResourcePayload("stake", data)).toBe(true);
  const view = toProtocolView({ resource: "stake", data });
  expect(view.coverage).toMatchObject({
    state: "partial",
    label: "Partial coverage",
    observedAt: data.coverage.fetched_at,
    snapshotSlot: 124,
  });
  expect(view.positions).toHaveLength(1);
  expect(view.pageValueUsd).toBeNull();
  expect(view.cursor).toBeNull();
  expect(view.hasMore).toBe(false);
  const position = view.positions[0];
  expect(position.valueUsd).toBe("123.456789");
  expect(position.assets).toEqual([
    {
      label: "SOL",
      amount: "18446744073.709551615",
      valueUsd: "123.456789",
    },
  ]);

  const { container } = render(<PositionDetail position={position} />);
  expectDetail(container, "Stake account", "synthetic-stake-account");
  expectDetail(container, "Account lamports", "18446744073709551615");
  expectDetail(container, "Staker", "synthetic-staker");
  expectDetail(container, "Authorized withdrawer", zeroPublicKey);
  expectDetail(container, "Lockup Unix timestamp (seconds)", "-1");
  expectDetail(container, "Lockup epoch", maxU64Epoch);
  expectDetail(container, "Lockup custodian", "synthetic-custodian");
  expectDetail(container, "Validator vote account", "synthetic-vote-account");
  expectDetail(container, "State", "delegated");
  expectDetail(container, "Delegated lamports", "9007199254740993");
  expectDetail(container, "Activation epoch", "9007199254740993");
  expectDetail(container, "Deactivation epoch", maxU64Epoch);
  expectDetail(container, "Rent reserve (lamports)", "2282880");
  expectDetail(container, "Snapshot slot", "123");
  expectDetail(container, "Valuation / delegation basis", basis);
  const terms = within(container).getAllByRole("term");
  expect(terms.some((term) => /effective|withdrawable|owner/i.test(term.textContent ?? ""))).toBe(false);
});

it("preserves zero amounts, epochs, Unix seconds and the zero vote public key", () => {
  const data = syntheticStoredStake({
    lamports: "0",
    rent_exempt_reserve: "0",
    vote_account: zeroPublicKey,
    delegated_lamports: "0",
    activation_epoch: "0",
    deactivation_epoch: "0",
    lockup_unix_timestamp: 0,
    lockup_epoch: "0",
    snapshot_slot: 0,
    value_usd: "0",
  });
  expect(validResourcePayload("stake", data)).toBe(true);
  const position = toProtocolView({ resource: "stake", data }).positions[0];
  expect(position.assets[0].amount).toBe("0");
  expect(position.valueUsd).toBe("0");
  const { container } = render(<PositionDetail position={position} />);
  expectDetail(container, "Account lamports", "0");
  expectDetail(container, "Validator vote account", zeroPublicKey);
  expectDetail(container, "Delegated lamports", "0");
  expectDetail(container, "Activation epoch", "0");
  expectDetail(container, "Deactivation epoch", "0");
  expectDetail(container, "Lockup Unix timestamp (seconds)", "0");
  expectDetail(container, "Lockup epoch", "0");
  expectDetail(container, "Rent reserve (lamports)", "0");
  expectDetail(container, "Snapshot slot", "0");
});

it.each([null, undefined])(
  "shows unknown for %s optional vote, delegation and epochs without inventing stake status",
  (missing) => {
    const data = syntheticStoredStake({
      state: "initialized",
      vote_account: missing,
      delegated_lamports: missing,
      activation_epoch: missing,
      deactivation_epoch: missing,
      value_usd: missing,
    });
    // Omitted optional JSON fields are absent rather than explicitly undefined.
    const payload: Schemas["WalletStakeAccounts"] = JSON.parse(JSON.stringify(data));
    expect(validResourcePayload("stake", payload)).toBe(true);
    const view = toProtocolView({ resource: "stake", data: payload });
    expect(view.positions).toHaveLength(1);
    expect(view.coverage.state).toBe("partial");
    expect(view.positions[0].valueUsd).toBeNull();
    const { container } = render(<PositionDetail position={view.positions[0]} />);
    expectDetail(container, "Validator vote account", "Unknown");
    expectDetail(container, "Delegated lamports", "Unknown");
    expectDetail(container, "Activation epoch", "Unknown");
    expectDetail(container, "Deactivation epoch", "Unknown");
    expectDetail(container, "State", "initialized");
  },
);

it("keeps the source basis note out of compact amounts", () => {
  const data = syntheticStoredStake();
  expect(validResourcePayload("stake", data)).toBe(true);
  const position = toProtocolView({ resource: "stake", data }).positions[0];
  const { container } = render(<Amounts values={position.assets} />);
  expect(container).not.toHaveTextContent(basis);
  expect(container).not.toHaveTextContent(/effective|withdrawable|rent reserve/i);
});
