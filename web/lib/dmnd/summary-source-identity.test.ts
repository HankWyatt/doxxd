import { expect, it } from "vitest";
import { createDmndClient } from "./client.server";
import type { ResourceData } from "./contracts";
import recorded from "../../tests/fixtures/dmnd-new-address-summary-refreshed.json";

const wallet = "aLqXroJ6z41nDQ9zEmqj5mPU86DJ1LXfABfAKxFzDS2";
const foreignWallet = "Fsx2Z8MEvG4DrBKq6mZBDaURMMKtPECjNKfeF15RfK4X";
const env = {
  DMND_API_BASE_URL: "https://example.test/api/v1",
  DMND_API_KEY: "synthetic-secret",
};
const summary = () => structuredClone(recorded.data) as ResourceData["summary"];

it("preserves a recorded summary's independent source observations and total", async () => {
  const result = await createDmndClient(env, async () =>
    Response.json(recorded.data),
  ).read(wallet, "summary");
  expect(result).toEqual({ ok: true, data: recorded.data });
});

it.each(recorded.data.components.map((component) => component.id))(
  "rejects a foreign-wallet %s source even when the summary wallet matches",
  async (id) => {
    const body = summary();
    const component = body.components.find((row) => row.id === id)!;
    component.source_path = component.source_path.replace(wallet, foreignWallet);
    const result = await createDmndClient(env, async () =>
      Response.json(body),
    ).read(wallet, "summary");
    expect(result).toEqual({ ok: false, kind: "upstream" });
  },
);

it.each([
  `/wallets/${wallet}/stake-accounts`,
  `/wallets/${wallet}/overview?protocol=kamino_lend`,
  `https://example.test/wallets/${wallet}/overview`,
  `/wallets/${wallet}/overview#coverage`,
])("rejects a known component's mismatched source %s", async (source) => {
  const body = summary();
  body.components[0].source_path = source;
  expect(
    await createDmndClient(env, async () => Response.json(body)).read(
      wallet,
      "summary",
    ),
  ).toEqual({ ok: false, kind: "upstream" });
});

it("rejects a known protocol component with another protocol's source", async () => {
  const body = summary();
  body.components.find((row) => row.id === "kamino_lend")!.source_path =
    `/wallets/${wallet}/defi-positions?protocol=solend`;
  expect(
    await createDmndClient(env, async () => Response.json(body)).read(
      wallet,
      "summary",
    ),
  ).toEqual({ ok: false, kind: "upstream" });
});

it("preserves an unknown wallet-scoped component without recomputing the headline", async () => {
  const body = summary();
  body.components.push({
    ...body.components[0],
    id: "future_protocol",
    source_path: `/wallets/${wallet}/future-positions?protocol=future`,
    known_asset_value_usd: "12.34567890123456789",
    known_net_value_usd: "12.34567890123456789",
  });
  body.known_component_net_value_usd = "8.76543210987654321";
  expect(
    await createDmndClient(env, async () => Response.json(body)).read(
      wallet,
      "summary",
    ),
  ).toEqual({ ok: true, data: body });
});

it.each([
  `/wallets/${wallet}/`,
  `/wallets/${wallet}/?protocol=future`,
  `/wallets/${wallet}/../${foreignWallet}/future-positions`,
  `/wallets/${wallet}/%2e%2e/${foreignWallet}/future-positions`,
  `/wallets/${wallet}/future-positions#another-wallet`,
  `/wallets/${wallet}/future-positions\\..\\..\\${foreignWallet}/overview`,
])("rejects a noncanonical future source %s", async (source) => {
  const body = summary();
  body.components[0].id = "future_protocol";
  body.components[0].source_path = source;
  expect(
    await createDmndClient(env, async () => Response.json(body)).read(
      wallet,
      "summary",
    ),
  ).toEqual({ ok: false, kind: "upstream" });
});
