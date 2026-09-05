import { describe, expect, it } from "vitest";
import {
  EventType,
  type Context,
  type PixelEventsCartViewed,
  type PixelEventsPageViewed,
  type PixelEventsProductAddedToCart,
  type PixelEventsProductViewed,
} from "@shopify/web-pixels-extension";
import {
  mapCartViewed,
  mapPageViewed,
  mapProductAddedToCart,
  mapProductViewed,
  type MapperContext,
} from "./eventMapper.js";

const baseContext: Context = {
  document: {
    characterSet: "UTF-8",
    location: {
      href: "https://store-a.example.com/products/widget?fbclid=abc",
    } as Context["document"]["location"],
    referrer: "https://google.com/search",
    title: "Widget – Store A",
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
  shopId: "store-a",
  trackingId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  attribution: { fbclid: "abc", utm_source: "meta" },
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

describe("mapPageViewed", () => {
  it("maps to a valid TrackingEventV1 shape reusing Shopify's own event id and timestamp", () => {
    const shopifyEvent: PixelEventsPageViewed = {
      clientId: "shopify-client-1",
      context: baseContext,
      data: {},
      id: "shopify-evt-1",
      name: "page_viewed",
      seq: 1,
      timestamp: "2026-09-04T12:00:00.000Z",
      type: EventType.Standard,
    };

    const mapped = mapPageViewed(shopifyEvent, ctx);

    expect(mapped.event_id).toBe("shopify-evt-1"); // reused, not regenerated
    expect(mapped.event_name).toBe("page_viewed");
    expect(mapped.event_time).toBe("2026-09-04T12:00:00.000Z");
    expect(mapped.shop).toEqual({ shop_id: "store-a", role: "storefront" });
    expect(mapped.identity).toEqual({
      tracking_id: ctx.trackingId,
      session_id: ctx.sessionId,
    });
    expect(mapped.attribution.fbclid).toBe("abc");
    expect(mapped.browser.page_url).toBe("https://store-a.example.com/products/widget?fbclid=abc");
    expect(mapped.source).toEqual({ origin: "browser", pixel_type: "app_pixel" });
    expect(mapped.commerce).toEqual({});
  });
});

describe("mapProductViewed", () => {
  it("extracts variant price/currency/content_ids without fabricating missing fields", () => {
    const shopifyEvent: PixelEventsProductViewed = {
      clientId: "c1",
      context: baseContext,
      data: {
        productVariant: {
          id: "gid://shopify/ProductVariant/999",
          image: null,
          price: { amount: 49.9, currencyCode: "USD" },
          product: { id: "gid://shopify/Product/1", title: "Widget", type: null, untranslatedTitle: "Widget", url: "/products/widget", vendor: "Acme" } as never,
          sku: "WID-1",
          title: "Widget",
          untranslatedTitle: "Widget",
        },
      },
      id: "shopify-evt-2",
      name: "product_viewed",
      seq: 2,
      timestamp: "2026-09-04T12:01:00.000Z",
      type: EventType.Standard,
    };

    const mapped = mapProductViewed(shopifyEvent, ctx);

    expect(mapped.commerce).toEqual({
      currency: "USD",
      value: 49.9,
      content_type: "product",
      content_ids: ["gid://shopify/ProductVariant/999"],
      contents: [{ id: "gid://shopify/ProductVariant/999", item_price: 49.9 }],
    });
  });
});

describe("mapProductAddedToCart", () => {
  it("maps cart line quantity/price when present", () => {
    const shopifyEvent: PixelEventsProductAddedToCart = {
      clientId: "c1",
      context: baseContext,
      data: {
        cartLine: {
          cost: { totalAmount: { amount: 99.8, currencyCode: "USD" } },
          merchandise: {
            id: "gid://shopify/ProductVariant/999",
            image: null,
            price: { amount: 49.9, currencyCode: "USD" },
            product: {} as never,
            sku: "WID-1",
            title: "Widget",
            untranslatedTitle: "Widget",
          },
          quantity: 2,
        },
      },
      id: "shopify-evt-3",
      name: "product_added_to_cart",
      seq: 3,
      timestamp: "2026-09-04T12:02:00.000Z",
      type: EventType.Standard,
    };

    const mapped = mapProductAddedToCart(shopifyEvent, ctx);

    expect(mapped.commerce.value).toBe(99.8);
    expect(mapped.commerce.num_items).toBe(2);
    expect(mapped.commerce.contents).toEqual([
      { id: "gid://shopify/ProductVariant/999", quantity: 2, item_price: 49.9 },
    ]);
  });

  it("degrades gracefully (empty commerce, no crash) when cartLine is null", () => {
    const shopifyEvent: PixelEventsProductAddedToCart = {
      clientId: "c1",
      context: baseContext,
      data: { cartLine: null },
      id: "shopify-evt-4",
      name: "product_added_to_cart",
      seq: 4,
      timestamp: "2026-09-04T12:03:00.000Z",
      type: EventType.Standard,
    };

    const mapped = mapProductAddedToCart(shopifyEvent, ctx);
    expect(mapped.commerce).toEqual({});
  });
});

describe("mapCartViewed", () => {
  it("sums cart lines into content_ids/contents/num_items", () => {
    const shopifyEvent: PixelEventsCartViewed = {
      clientId: "c1",
      context: baseContext,
      data: {
        cart: {
          attributes: [],
          cost: { totalAmount: { amount: 149.7, currencyCode: "USD" } },
          id: "gid://shopify/Cart/1",
          lines: [
            {
              cost: { totalAmount: { amount: 99.8, currencyCode: "USD" } },
              merchandise: {
                id: "gid://shopify/ProductVariant/999",
                image: null,
                price: { amount: 49.9, currencyCode: "USD" },
                product: {} as never,
                sku: "WID-1",
                title: "Widget",
                untranslatedTitle: "Widget",
              },
              quantity: 2,
            },
          ],
          totalQuantity: 2,
        },
      },
      id: "shopify-evt-5",
      name: "cart_viewed",
      seq: 5,
      timestamp: "2026-09-04T12:04:00.000Z",
      type: EventType.Standard,
    };

    const mapped = mapCartViewed(shopifyEvent, ctx);
    expect(mapped.commerce.num_items).toBe(2);
    expect(mapped.commerce.content_ids).toEqual(["gid://shopify/ProductVariant/999"]);
  });
});
