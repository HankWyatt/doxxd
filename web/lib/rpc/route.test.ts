// @vitest-environment node
// The /api/rpc route module: its off switch and the methods it answers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "@/app/api/rpc/route";

const URL_ = "https://doxxd.test/api/rpc";
const OTHER_METHODS = ["GET", "OPTIONS", "PUT", "PATCH", "DELETE"] as const;
type Handler = (request: Request) => Promise<Response>;
const handlers = route as unknown as Record<string, Handler | undefined>;

const request = (method: string) =>
  new Request(URL_, {
    method,
    headers: { "content-type": "application/json", origin: "https://doxxd.test" },
    ...(method === "GET" ? {} : { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }) }),
  });

const upstream = vi.fn(async (_input: unknown, init?: RequestInit) =>
  Response.json({ jsonrpc: "2.0", id: JSON.parse(String(init?.body)).id, result: 7 }),
);

beforeEach(() => {
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  upstream.mockClear();
});

describe("/api/rpc route", () => {
  it("exports a handler for POST and every other method it must refuse", () => {
    for (const method of ["POST", ...OTHER_METHODS]) expect(typeof handlers[method], method).toBe("function");
  });

  it("answers 404 for every method when actions are off", async () => {
    vi.stubEnv("DOXXD_ACTIONS_ENABLED", "");
    vi.stubEnv("SOLANA_RPC_URL", "https://rpc.provider.test/");
    for (const method of ["POST", ...OTHER_METHODS])
      expect((await handlers[method]!(request(method))).status, method).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 404 when actions are on but no RPC provider URL is set (R-FW1)", async () => {
    vi.stubEnv("DOXXD_ACTIONS_ENABLED", "1");
    vi.stubEnv("SOLANA_RPC_URL", "");
    for (const method of ["POST", ...OTHER_METHODS])
      expect((await handlers[method]!(request(method))).status, method).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 405 to everything but POST when on, and forwards POST to SOLANA_RPC_URL", async () => {
    vi.stubEnv("DOXXD_ACTIONS_ENABLED", "1");
    vi.stubEnv("SOLANA_RPC_URL", "https://rpc.provider.test/");
    for (const method of OTHER_METHODS) {
      const response = await handlers[method]!(request(method));
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    const response = await handlers.POST!(request("POST"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: 7 });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][0]).toBe("https://rpc.provider.test/");
  });
});
