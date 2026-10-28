import { expect, it } from "vitest";
import { createDmndClient } from "./client.server";
import { resources } from "./resources";
import { DEMO_ADDRESS, readFixture } from "../fixtures/wallet";
import type { ResourceName } from "./contracts";

const env = {
  DMND_API_KEY: "synthetic-secret",
  DMND_API_BASE_URL: "https://example.test/api/v1",
  DMND_ENABLED_PROTOCOLS: Object.keys(resources).join(","),
};
const fixture = (resource: ResourceName): any => {
  const result = readFixture(resource, "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  return result.data;
};
it.each(Object.keys(resources) as ResourceName[])(
  "accepts the full valid %s fixture",
  async (resource) => {
    const data = fixture(resource);
    const client = createDmndClient(env, async () => Response.json(data));
    expect(await client.read(DEMO_ADDRESS, resource)).toEqual({
      ok: true,
      data,
    });
  },
);
it.each([
  [
    "overview",
    (body: any) => {
      body.coverage = {};
    },
  ],
  [
    "overview",
    (body: any) => {
      body.assets[0].symbol = {};
    },
  ],
  [
    "summary",
    (body: any) => {
      delete body.components[0].coverage_status;
    },
  ],
  [
    "summary",
    (body: any) => {
      body.components[0].included_in_known_total = "false";
    },
  ],
  [
    "transactions",
    (body: any) => {
      body.data[0].changes = [{}];
    },
  ],
  [
    "transactions",
    (body: any) => {
      body.data[0].observed_trades[0].exchange = null;
    },
  ],
  [
    "activity",
    (body: any) => {
      body.data = [{}];
    },
  ],
  [
    "activity",
    (body: any) => {
      body.data[0].ui_amount = {};
    },
  ],
] as const)(
  "rejects malformed %s structures before presentation",
  async (resource, corrupt) => {
    const data = fixture(resource);
    corrupt(data);
    const client = createDmndClient(env, async () => Response.json(data));
    expect(await client.read(DEMO_ADDRESS, resource)).toEqual({
      ok: false,
      kind: "upstream",
    });
  },
);
