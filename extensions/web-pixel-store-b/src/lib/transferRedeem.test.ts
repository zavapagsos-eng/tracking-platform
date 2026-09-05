import { describe, expect, it, vi } from "vitest";
import { findTransferToken, redeemTransfer } from "./transferRedeem.js";

describe("findTransferToken", () => {
  it("finds the ttid attribute among others", () => {
    const token = findTransferToken([
      { key: "gift_note", value: "Happy birthday" },
      { key: "ttid", value: "abc123" },
    ]);
    expect(token).toBe("abc123");
  });

  it("returns undefined when absent, never fabricating one", () => {
    expect(findTransferToken([{ key: "other", value: "x" }])).toBeUndefined();
    expect(findTransferToken([])).toBeUndefined();
    expect(findTransferToken(null)).toBeUndefined();
    expect(findTransferToken(undefined)).toBeUndefined();
  });
});

describe("redeemTransfer", () => {
  const baseOptions = {
    attributes: [{ key: "ttid", value: "tok-1" }],
    sessionId: "22222222-2222-4222-8222-222222222222",
    appProxyBasePath: "/apps/tracking",
  };

  it("returns no_token without making a network call when the attribute is absent", async () => {
    const fetchImpl = vi.fn();
    const result = await redeemTransfer({ ...baseOptions, attributes: [], fetchImpl: fetchImpl as never });
    expect(result).toEqual({ status: "no_token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns redeemed with tracking/session ids on success", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "redeemed",
            tracking_id: "11111111-1111-4111-8111-111111111111",
            source_session_id: "33333333-3333-4333-8333-333333333333",
          }),
          { status: 200 },
        ),
    );
    const result = await redeemTransfer({ ...baseOptions, fetchImpl: fetchImpl as never });
    expect(result).toEqual({
      status: "redeemed",
      trackingId: "11111111-1111-4111-8111-111111111111",
      sourceSessionId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it.each([
    [404, "not_found"],
    [410, "expired"],
    [409, "replay_detected"],
    [500, "error"],
  ] as const)("maps HTTP %i to status %s", async (httpStatus, expectedStatus) => {
    const fetchImpl = vi.fn(async () => new Response("", { status: httpStatus }));
    const result = await redeemTransfer({ ...baseOptions, fetchImpl: fetchImpl as never });
    expect(result.status).toBe(expectedStatus);
  });

  it("returns error (never throws) on a network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await redeemTransfer({ ...baseOptions, fetchImpl: fetchImpl as never });
    expect(result).toEqual({ status: "error" });
  });
});
