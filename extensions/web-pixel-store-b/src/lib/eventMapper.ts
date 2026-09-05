import type {
  Checkout,
  PixelEventsCheckoutAddressInfoSubmitted,
  PixelEventsCheckoutCompleted,
  PixelEventsCheckoutContactInfoSubmitted,
  PixelEventsCheckoutShippingInfoSubmitted,
  PixelEventsCheckoutStarted,
  PixelEventsPaymentInfoSubmitted,
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
) {
  return {
    schema_version: "1.0" as const,
    event_id: eventId,
    event_name: eventName,
    event_time: eventTime,
    shop: { shop_id: ctx.shopId, role: "checkout" as const },
    identity: { tracking_id: ctx.trackingId, session_id: ctx.sessionId },
    attribution: { ...ctx.attribution },
    browser: { page_url: pageUrl, user_agent: ctx.userAgent, locale: ctx.locale },
    consent: ctx.consent,
    source: { origin: "browser" as const, pixel_type: "app_pixel" as const },
    metadata: { environment: ctx.environment },
  };
}

/** Shared commerce extraction — every checkout_* standard event's `data`
 * carries a `Checkout` object with the same shape (spec section 11: all of
 * these map onto InitiateCheckout/AddPaymentInfo/Purchase). */
function commerceFromCheckout(checkout: Checkout) {
  const lineItemIds = checkout.lineItems
    .map((line) => line.id)
    .filter((id): id is string => Boolean(id));

  return {
    currency: checkout.currencyCode ?? undefined,
    // Checkout has no single top-level "total" field guaranteed present
    // across all sub-events in the public type — subtotal/total amounts
    // are read from `order` once available (checkout_completed) or left
    // absent rather than guessed. See Phase 6 note in docs/PHASE_LOG.md.
    checkout_token: checkout.token ?? undefined,
    order_id: checkout.order?.id ?? undefined,
    content_type: "product" as const,
    content_ids: lineItemIds,
    num_items: checkout.lineItems.length,
  };
}

export function mapCheckoutStarted(
  event: PixelEventsCheckoutStarted,
  ctx: MapperContext,
): TrackingEventV1 {
  const pageUrl = event.context.document.location.href;
  return {
    ...baseEnvelope(ctx, event.id, "checkout_started", toIsoTimestamp(event.timestamp), pageUrl),
    commerce: commerceFromCheckout(event.data.checkout),
  };
}

export function mapCheckoutContactInfoSubmitted(
  event: PixelEventsCheckoutContactInfoSubmitted,
  ctx: MapperContext,
): TrackingEventV1 {
  const pageUrl = event.context.document.location.href;
  return {
    ...baseEnvelope(
      ctx,
      event.id,
      "checkout_contact_info_submitted",
      toIsoTimestamp(event.timestamp),
      pageUrl,
    ),
    commerce: commerceFromCheckout(event.data.checkout),
  };
}

export function mapCheckoutAddressInfoSubmitted(
  event: PixelEventsCheckoutAddressInfoSubmitted,
  ctx: MapperContext,
): TrackingEventV1 {
  const pageUrl = event.context.document.location.href;
  return {
    ...baseEnvelope(
      ctx,
      event.id,
      "checkout_address_info_submitted",
      toIsoTimestamp(event.timestamp),
      pageUrl,
    ),
    commerce: commerceFromCheckout(event.data.checkout),
  };
}

export function mapCheckoutShippingInfoSubmitted(
  event: PixelEventsCheckoutShippingInfoSubmitted,
  ctx: MapperContext,
): TrackingEventV1 {
  const pageUrl = event.context.document.location.href;
  return {
    ...baseEnvelope(
      ctx,
      event.id,
      "checkout_shipping_info_submitted",
      toIsoTimestamp(event.timestamp),
      pageUrl,
    ),
    commerce: commerceFromCheckout(event.data.checkout),
  };
}

export function mapPaymentInfoSubmitted(
  event: PixelEventsPaymentInfoSubmitted,
  ctx: MapperContext,
): TrackingEventV1 {
  const pageUrl = event.context.document.location.href;
  return {
    ...baseEnvelope(ctx, event.id, "payment_info_submitted", toIsoTimestamp(event.timestamp), pageUrl),
    commerce: commerceFromCheckout(event.data.checkout),
  };
}

/**
 * `checkout_completed` is the ONLY standard event where `Checkout.order.id`
 * is populated. This browser-side signal is deliberately never treated as
 * the authoritative Purchase — the Gateway's webhook-first rule (spec
 * section 21, enforced in TrackingEventV1 itself — see
 * SERVER_ONLY_EVENT_NAMES in packages/schema) means this maps to
 * `checkout_completed`, NOT `order_paid`. It is still valuable: it is the
 * natural place to fire the browser-side Meta Pixel Purchase (for
 * Pixel/CAPI deduplication against the server-side Purchase built from the
 * webhook in Phase 9/10) and to correlate `order_id` back to this checkout
 * session immediately, before the webhook arrives.
 */
export function mapCheckoutCompleted(
  event: PixelEventsCheckoutCompleted,
  ctx: MapperContext,
): TrackingEventV1 {
  const pageUrl = event.context.document.location.href;
  return {
    ...baseEnvelope(ctx, event.id, "checkout_completed", toIsoTimestamp(event.timestamp), pageUrl),
    commerce: commerceFromCheckout(event.data.checkout),
  };
}
