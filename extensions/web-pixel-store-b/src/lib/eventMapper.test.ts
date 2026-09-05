import { describe, expect, it } from "vitest";
import {
  EventType,
  type Checkout,
  type Context,
  type PixelEventsCheckoutCompleted,
  type PixelEventsCheckoutStarted,
} from "@shopify/web-pixels-extension";
import { mapCheckoutCompleted, mapCheckoutStarted, type MapperContext } from "./eventMapper.js";

const baseContext: Context = {
  document: {
    characterSet: "UTF-8",
    location: { href: "https://store-b.example.com/checkouts/abc" } as Context["document"]["location"],
    referrer: "https://store-a.example.com/cart",
    title: "Checkout",
  },
  navigator: {
    cookieEnabled: true,
    language: "en-US",
    languages: ["en-US"],
    userAgent: "Mozilla/5.0 (test)",
  },
  window: { innerHeight: 900, innerWidth: 1440, location: {} } as Context["window"],
};

const ctx: MapperContext = {
  shopId: "store-b",
  trackingId: "11111111-1111-4111-8111-111111111111",
  sessionId: "44444444-4444-4444-8444-444444444444",
  attribution: {},
  userAgent: "Mozilla/5.0 (test)",
  locale: "en-US",
  consent: {
    analyticsProcessingAllowed: true,
    marketingAllowed: true,
    preferencesProcessingAllowed: false,
    saleOfDataAllowed: false,
  },
  environment: "development",
};

function baseCheckout(overrides: Partial<Checkout> = {}): Checkout {
  return {
    attributes: [{ key: "ttid", value: "transfer-token-abc" }],
    billingAddress: null,
    buyerAcceptsEmailMarketing: false,
    buyerAcceptsSmsMarketing: false,
    currencyCode: "USD",
    delivery: null,
    discountApplications: [],
    discountsAmount: null,
    email: null,
    lineItems: [
      {
        id: "gid://shopify/CheckoutLineItem/1",
      } as never,
    ],
    localization: null as never,
    order: null,
    phone: null,
    shippingAddress: null,
    shippingLine: null,
    smsMarketingPhone: null,
    subtotalPrice: null as never,
    token: "checkout-token-xyz",
    totalPrice: null as never,
    totalTax: null as never,
    transactions: [],
    ...overrides,
  } as Checkout;
}

describe("mapCheckoutStarted", () => {
  it("maps checkout_token and content_ids from the Checkout payload", () => {
    const event: PixelEventsCheckoutStarted = {
      clientId: "c1",
      context: baseContext,
      data: { checkout: baseCheckout() },
      id: "shopify-evt-10",
      name: "checkout_started",
      seq: 1,
      timestamp: "2026-09-04T13:00:00.000Z",
      type: EventType.Standard,
    };

    const mapped = mapCheckoutStarted(event, ctx);

    expect(mapped.event_name).toBe("checkout_started");
    expect(mapped.shop).toEqual({ shop_id: "store-b", role: "checkout" });
    expect(mapped.commerce.checkout_token).toBe("checkout-token-xyz");
    expect(mapped.commerce.currency).toBe("USD");
    expect(mapped.commerce.content_ids).toEqual(["gid://shopify/CheckoutLineItem/1"]);
    expect(mapped.commerce.order_id).toBeUndefined(); // never populated before checkout_completed
  });
});

describe("mapCheckoutCompleted", () => {
  it("surfaces order_id only here, never fabricated on earlier steps", () => {
    const event: PixelEventsCheckoutCompleted = {
      clientId: "c1",
      context: baseContext,
      data: {
        checkout: baseCheckout({
          order: { customer: null, id: "gid://shopify/Order/555" },
        }),
      },
      id: "shopify-evt-11",
      name: "checkout_completed",
      seq: 6,
      timestamp: "2026-09-04T13:05:00.000Z",
      type: EventType.Standard,
    };

    const mapped = mapCheckoutCompleted(event, ctx);

    expect(mapped.event_name).toBe("checkout_completed");
    expect(mapped.commerce.order_id).toBe("gid://shopify/Order/555");
  });
});
