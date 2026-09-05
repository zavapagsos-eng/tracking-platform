import { describe, expect, it } from "vitest";
import { parseTrackingEvent } from "./trackingEventEnvelope.js";

const baseIdentity = {
  tracking_id: "11111111-1111-4111-8111-111111111111",
  session_id: "22222222-2222-4222-8222-222222222222",
};

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0",
    event_id: "evt_123",
    event_name: "product_viewed",
    event_time: new Date().toISOString(),
    shop: { shop_id: "store-a", role: "storefront" },
    identity: { ...baseIdentity },
    source: { origin: "browser" },
    metadata: { environment: "development" },
    ...overrides,
  };
}

describe("TrackingEventV1", () => {
  it("accepts a minimal valid browser event", () => {
    const result = parseTrackingEvent(makeEvent());
    expect(result.ok).toBe(true);
  });

  it("defaults optional nested objects (attribution/browser/commerce/consent)", () => {
    const result = parseTrackingEvent(makeEvent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.attribution).toEqual({});
      expect(result.event.commerce).toEqual({});
    }
  });

  it("accepts legitimately available attribution/browser data without fabricating anything", () => {
    const result = parseTrackingEvent(
      makeEvent({
        attribution: {
          fbclid: "abc123",
          utm_source: "meta",
          utm_campaign: "summer_sale",
          landing_page: "https://store-a.example.com/products/x",
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.attribution.fbclid).toBe("abc123");
      // fbc/fbp were never provided — must stay absent, not null or invented.
      expect(result.event.attribution.fbc).toBeUndefined();
    }
  });

  it("rejects an unknown event_name", () => {
    const result = parseTrackingEvent(makeEvent({ event_name: "made_up_event" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a missing identity.tracking_id", () => {
    const payload = makeEvent();
    // @ts-expect-error deliberately malformed for the test
    delete payload.identity.tracking_id;
    const result = parseTrackingEvent(payload);
    expect(result.ok).toBe(false);
  });

  it("rejects an unsupported schema_version", () => {
    const result = parseTrackingEvent(makeEvent({ schema_version: "9.9" }));
    expect(result.ok).toBe(false);
  });

  it("enforces webhook-first purchase: order_paid cannot come from the browser", () => {
    const result = parseTrackingEvent(
      makeEvent({
        event_name: "order_paid",
        source: { origin: "browser" },
        commerce: { order_id: "1001", currency: "USD", value: 99.9 },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("allows order_paid from a webhook source", () => {
    const result = parseTrackingEvent(
      makeEvent({
        event_name: "order_paid",
        shop: { shop_id: "store-b", role: "checkout" },
        source: { origin: "webhook", ingested_via: "shopify_admin_webhook" },
        commerce: { order_id: "1001", currency: "USD", value: 99.9 },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects fields with the wrong type instead of coercing them", () => {
    const result = parseTrackingEvent(
      makeEvent({ commerce: { value: "99.90" } }), // string, not number
    );
    expect(result.ok).toBe(false);
  });
});
