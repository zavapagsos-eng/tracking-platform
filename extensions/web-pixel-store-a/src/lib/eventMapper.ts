import type {
  PixelEventsCartViewed,
  PixelEventsPageViewed,
  PixelEventsProductAddedToCart,
  PixelEventsProductViewed,
} from "@shopify/web-pixels-extension";
import type { TrackingEventV1 } from "@tracking/schema";
import type { CapturedAttribution } from "@tracking/pixel-kit";

export interface MapperContext {
  shopId: string;
  trackingId: string;
  sessionId: string;
  attribution: CapturedAttribution;
  userAgent?: string;
  locale?: string;
  consent: {
    analyticsProcessingAllowed: boolean;
    marketingAllowed: boolean;
    preferencesProcessingAllowed: boolean;
    saleOfDataAllowed: boolean;
  };
  environment: "development" | "staging" | "production";
}

/** Coerces Shopify's `Timestamp` (documented as `string`, format not
 * formally pinned) into the exact ISO 8601 shape TrackingEventV1 requires,
 * rather than trusting it matches byte-for-byte. Falls back to "now" only
 * if the value is genuinely unparseable — never fabricates a business
 * fact, just guards a formatting mismatch. */
function toIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function baseEnvelope(
  ctx: MapperContext,
  eventId: string,
  eventName: TrackingEventV1["event_name"],
  eventTime: string,
  pageUrl?: string,
): Pick<
  TrackingEventV1,
  "schema_version" | "event_id" | "event_name" | "event_time" | "shop" | "identity" | "attribution" | "browser" | "consent" | "source" | "metadata"
> {
  return {
    schema_version: "1.0",
    event_id: eventId,
    event_name: eventName,
    event_time: eventTime,
    shop: { shop_id: ctx.shopId, role: "storefront" },
    identity: { tracking_id: ctx.trackingId, session_id: ctx.sessionId },
    attribution: { ...ctx.attribution },
    browser: {
      page_url: pageUrl,
      user_agent: ctx.userAgent,
      locale: ctx.locale,
    },
    consent: ctx.consent,
    source: { origin: "browser", pixel_type: "app_pixel" },
    metadata: { environment: ctx.environment },
  };
}

export function mapPageViewed(event: PixelEventsPageViewed, ctx: MapperContext): TrackingEventV1 {
  const pageUrl = event.context.document.location.href;
  return {
    ...baseEnvelope(ctx, event.id, "page_viewed", toIsoTimestamp(event.timestamp), pageUrl),
    commerce: {},
  };
}

export function mapProductViewed(
  event: PixelEventsProductViewed,
  ctx: MapperContext,
): TrackingEventV1 {
  const variant = event.data.productVariant;
  const pageUrl = event.context.document.location.href;

  return {
    ...baseEnvelope(ctx, event.id, "product_viewed", toIsoTimestamp(event.timestamp), pageUrl),
    commerce: {
      currency: variant.price.currencyCode,
      value: variant.price.amount,
      content_type: "product",
      content_ids: variant.id ? [variant.id] : [],
      contents: variant.id ? [{ id: variant.id, item_price: variant.price.amount }] : [],
    },
  };
}

export function mapProductAddedToCart(
  event: PixelEventsProductAddedToCart,
  ctx: MapperContext,
): TrackingEventV1 {
  const line = event.data.cartLine;
  const pageUrl = event.context.document.location.href;
  const base = baseEnvelope(ctx, event.id, "product_added_to_cart", toIsoTimestamp(event.timestamp), pageUrl);

  if (!line) {
    // Shopify's own type marks `cartLine` nullable — when it happens, we
    // still record the event (something legitimately occurred) but without
    // fabricating commerce details that weren't provided.
    return { ...base, commerce: {} };
  }

  const variantId = line.merchandise.id;
  return {
    ...base,
    commerce: {
      currency: line.cost.totalAmount.currencyCode,
      value: line.cost.totalAmount.amount,
      content_type: "product",
      content_ids: variantId ? [variantId] : [],
      contents: variantId
        ? [{ id: variantId, quantity: line.quantity, item_price: line.merchandise.price.amount }]
        : [],
      num_items: line.quantity,
    },
  };
}

export function mapCartViewed(event: PixelEventsCartViewed, ctx: MapperContext): TrackingEventV1 {
  const cart = event.data.cart;
  const pageUrl = event.context.document.location.href;
  const base = baseEnvelope(ctx, event.id, "cart_viewed", toIsoTimestamp(event.timestamp), pageUrl);

  if (!cart) {
    return { ...base, commerce: {} };
  }

  return {
    ...base,
    commerce: {
      currency: cart.cost.totalAmount.currencyCode,
      value: cart.cost.totalAmount.amount,
      content_type: "product",
      content_ids: cart.lines.map((l) => l.merchandise.id).filter((id): id is string => Boolean(id)),
      contents: cart.lines
        .filter((l) => l.merchandise.id)
        .map((l) => ({
          id: l.merchandise.id as string,
          quantity: l.quantity,
          item_price: l.merchandise.price.amount,
        })),
      num_items: cart.totalQuantity,
    },
  };
}
