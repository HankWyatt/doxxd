import { afterEach, expect, it, vi } from "vitest";
import { GET } from "../../app/api/wallet/[address]/[resource]/route";
const params = Promise.resolve({
  address: "7yW6xxcWv2bGX2KkXDCf8qx9Fu7JXraT2m2YZ2f3tWsa",
  resource: "summary",
});
afterEach(() => vi.unstubAllEnvs());
it("fails closed if bounded mode is configured without the private token binding", async () => {
  vi.stubEnv("DMND_REQUEST_BUDGET", "34");
  vi.stubEnv("DMND_ACCEPTANCE_PROXY_TOKEN", "");
  vi.stubEnv("DMND_API_KEY", "");
  const response = await GET(
    new Request("http://127.0.0.1/api/wallet/test/summary"),
    { params },
  );
  expect(response.status).toBe(403);
});
it("refuses direct access to a bounded internal Worker without its private proxy header", async () => {
  vi.stubEnv("DMND_ACCEPTANCE_PROXY_TOKEN", "synthetic-proxy-token");
  const response = await GET(
    new Request("http://127.0.0.1/api/wallet/test/summary"),
    { params },
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    ok: false,
    kind: "authentication",
    upstreamStatus: 403,
  });
});
it("permits the proxy header while keeping a missing service credential unavailable", async () => {
  vi.stubEnv("DMND_ACCEPTANCE_PROXY_TOKEN", "synthetic-proxy-token");
  vi.stubEnv("DMND_API_KEY", "");
  const response = await GET(
    new Request("http://127.0.0.1/api/wallet/test/summary", {
      headers: { "x-doxxd-acceptance-token": "synthetic-proxy-token" },
    }),
    { params },
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, kind: "configuration" });
});
