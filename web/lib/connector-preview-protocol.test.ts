import { describe, expect, it } from "vitest";
import {
  driverMessageSchema,
  grantSchema,
  grantsSchema,
  invocationSchema,
  sessionOptionsSchema,
} from "../scripts/connector-preview/protocol.mjs";

const id = "123e4567-e89b-42d3-a456-426614174000";
const envelope = { connectorId: "example", actionName: "list" };

describe("connector preview protocol schemas", () => {
  it("accepts an invocation whose arguments are a string-keyed record", () => {
    const value = { ...envelope, arguments: { limit: 1, filter: { nested: true } } };
    expect(invocationSchema.parse(value)).toEqual(value);
  });

  it("rejects extra invocation fields and non-record arguments", () => {
    expect(invocationSchema.safeParse({ ...envelope, arguments: {}, account: "x" }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...envelope, arguments: [1] }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...envelope, arguments: "x" }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...envelope, arguments: null }).success).toBe(false);
  });

  it("accepts read-only grants only", () => {
    expect(grantsSchema.parse([{ ...envelope, readOnly: true }])).toHaveLength(1);
    expect(grantSchema.safeParse({ ...envelope, readOnly: false }).success).toBe(false);
    expect(grantSchema.safeParse({ ...envelope, readOnly: true, extra: 1 }).success).toBe(false);
  });

  it("applies session defaults and rejects invalid options", () => {
    expect(sessionOptionsSchema.parse({})).toEqual({ timeoutMs: 120000, maxConcurrent: 64 });
    expect(sessionOptionsSchema.safeParse({ timeoutMs: -1 }).success).toBe(false);
    expect(sessionOptionsSchema.safeParse({ timeoutMs: 2 ** 31 }).success).toBe(false);
    expect(sessionOptionsSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it("accepts stop, result and error driver messages", () => {
    expect(driverMessageSchema.safeParse({ jsonrpc: "2.0", method: "stop" }).success).toBe(true);
    expect(driverMessageSchema.safeParse({ jsonrpc: "2.0", id, result: { content: [] } }).success).toBe(true);
    expect(
      driverMessageSchema.safeParse({ jsonrpc: "2.0", id, error: { code: -32000, message: "failed" } }).success,
    ).toBe(true);
  });

  it("rejects a malformed id, a non-record result and extra message fields", () => {
    expect(driverMessageSchema.safeParse({ jsonrpc: "2.0", id: "not-a-uuid", result: {} }).success).toBe(false);
    expect(driverMessageSchema.safeParse({ jsonrpc: "2.0", id, result: [] }).success).toBe(false);
    expect(driverMessageSchema.safeParse({ jsonrpc: "2.0", id, result: {}, extra: 1 }).success).toBe(false);
  });
});
