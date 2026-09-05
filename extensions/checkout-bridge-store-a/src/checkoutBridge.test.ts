import { describe, expect, it, vi } from "vitest";
import { initiateTransferAndRedirect, shapeCartForTransfer } from "./checkoutBridge.js";

describe("shapeCartForTransfer", () => {
  it("maps cart.js items using variant_id when present", () => {
    const result = shapeCartForTransfer({
      items: [{ variant_id: 999, id: 111, quantity: 2 }],
    });
    expect(result).toEqual([{ variant_id: "999", quantity: 2 }]);
  });

  it("falls back to id when variant_id is absent (older cart.js shape)", () => {
    const result = shapeCartForTransfer({ items: [{ id: 777, quantity: 1 }] });
    expect(result).toEqual([{ variant_id: "777", quantity: 1 }]);
  });

  it("drops lines with neither id nor variant_id rather than fabricating one", () => {
    const result = shapeCartForTransfer({ items: [{ quantity: 3 } as never] });
    expect(result).toEqual([]);
  });
});

describe("initiateTransferAndRedirect", () => {
  const baseOptions = {
    trackingId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    cart: { items: [{ variant_id: 999, quantity: 1 }] },
    destinationShopId: "store-b",
    appProxyBasePath: "/apps/tracking",
    gatewayPublicUrl: "https://gateway.example.com",
    fallbackCheckoutUrl: "https://store-b.example.com/cart/999:1",
  };

  it("redirects to the gateway's /r/:token path on success", async () => {
    const redirect = vi.fn();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ redirect_path: "/r/abc123" }), { status: 201 }),
    );

    await initiateTransferAndRedirect({ ...baseOptions, fetchImpl: fetchImpl as never, redirect });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/apps/tracking/transfer/create",
      expect.objectContaining({ method: "POST" }),
    );
    expect(redirect).toHaveBeenCalledWith("https://gateway.example.com/r/abc123");
  });

  it("falls back to the checkout URL when the Gateway responds with an error status", async () => {
    const redirect = vi.fn();
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));

    await initiateTransferAndRedirect({ ...baseOptions, fetchImpl: fetchImpl as never, redirect });

    expect(redirect).toHaveBeenCalledWith(baseOptions.fallbackCheckoutUrl);
  });

  it("falls back to the checkout URL when fetch throws (network error)", async () => {
    const redirect = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    await initiateTransferAndRedirect({ ...baseOptions, fetchImpl: fetchImpl as never, redirect });

    expect(redirect).toHaveBeenCalledWith(baseOptions.fallbackCheckoutUrl);
  });

  it("falls back to the checkout URL when the Gateway is slower than the timeout", async () => {
    const redirect = vi.fn();
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    await initiateTransferAndRedirect({
      ...baseOptions,
      fetchImpl: fetchImpl as never,
      redirect,
      timeoutMs: 10,
    });

    expect(redirect).toHaveBeenCalledWith(baseOptions.fallbackCheckoutUrl);
  });

  it("never sends a secret or signature in the request — App Proxy signs it server-side", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ redirect_path: "/r/x" }), { status: 201 }),
    );
    await initiateTransferAndRedirect({ ...baseOptions, fetchImpl: fetchImpl as never, redirect: vi.fn() });

    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("x-gateway-signature");
    expect(JSON.stringify(init)).not.toMatch(/secret/i);
  });

  it("sends destination_shop_id so the Gateway can resolve the right destination store", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ redirect_path: "/r/abc123" }), { status: 201 }),
    );
    await initiateTransferAndRedirect({
      ...baseOptions,
      destinationShopId: "store-c",
      fetchImpl: fetchImpl as never,
      redirect: vi.fn(),
    });

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.destination_shop_id).toBe("store-c");
  });
});
