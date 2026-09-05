import { z } from "zod";

/**
 * TrackingEventV1 — universal event envelope.
 *
 * Every event ingested by the Tracking Gateway (browser via Web Pixel,
 * server-to-server, or derived from a Shopify webhook) is normalized into
 * this shape before validation, persistence, and downstream processing.
 *
 * Design rules (see docs/ARCHITECTURE.md section F/K/L):
 *  - Nothing here is fabricated: every field is optional unless it is
 *    structurally required to route/identify the event.
 *  - `schema_version` is a literal discriminator so future versions
 *    (TrackingEventV2, ...) can be added without breaking old events
 *    already persisted — see `trackingEventEnvelope.ts`.
 *  - No fingerprinting fields (canvas/WebGL/font/etc.) are modeled here on
 *    purpose; IP/User-Agent are carried as plain contextual attributes,
 *    never as identity keys (enforced in the Identity Graph layer, not here).
 */

/** Event names the platform understands, sourced from the Shopify Customer
 * Events taxonomy plus a small set of gateway/webhook-origin events.
 * Mapping to Meta Pixel/CAPI event names happens downstream in the
 * Event Taxonomy mapper — this enum intentionally stays in "Shopify"
 * vocabulary so the envelope is source-of-truth agnostic. */
export const TRACKING_EVENT_NAMES = [
  // Storefront (Store A) — Shopify standard customer events
  "page_viewed",
  "product_viewed",
  "product_added_to_cart",
  "cart_viewed",
  // Checkout (Store B) — Shopify standard customer events
  "checkout_started",
  "checkout_contact_info_submitted",
  "checkout_address_info_submitted",
  "checkout_shipping_info_submitted",
  "payment_info_submitted",
  "checkout_completed",
  // Gateway-internal / cross-domain bridge
  "transfer_created",
  "transfer_redeemed",
  // Webhook-originated (server-to-server, never from a browser)
  "order_created",
  "order_paid",
  "order_cancelled",
  "refund_created",
] as const;

export type TrackingEventName = (typeof TRACKING_EVENT_NAMES)[number];

/** Events that MUST NOT arrive with source.origin === "browser". These are
 * the financial/authoritative events — accepting them from the browser
 * would violate the "webhook-first purchase" rule (spec section 21). */
export const SERVER_ONLY_EVENT_NAMES = new Set<TrackingEventName>([
  "order_created",
  "order_paid",
  "order_cancelled",
  "refund_created",
  "transfer_redeemed",
]);

const shopRoleSchema = z.enum(["storefront", "checkout"]);

const shopSchema = z.object({
  shop_id: z.string().min(1),
  shop_domain: z.string().min(1).optional(),
  role: shopRoleSchema,
});

const identitySchema = z.object({
  tracking_id: z.string().uuid(),
  session_id: z.string().uuid(),
  /** External ID we control and can legitimately hash for Meta `external_id`. */
  external_id: z.string().min(1).optional(),
  shopify_customer_id: z.string().min(1).optional(),
});

const attributionSchema = z.object({
  fbclid: z.string().min(1).optional(),
  /** Raw `_fbc` cookie value, captured as-is — never fabricated when absent. */
  fbc: z.string().min(1).optional(),
  /** Raw `_fbp` cookie value. */
  fbp: z.string().min(1).optional(),
  /** Google Ads' own click id — see packages/pixel-kit's `captureAttribution`
   * for how it's captured (same URL-param pattern as `fbclid`). Captured
   * even before any Google Ads campaign is live, so historical clicks
   * aren't lost by the time that integration is built. */
  gclid: z.string().min(1).optional(),
  utm_source: z.string().min(1).optional(),
  utm_medium: z.string().min(1).optional(),
  utm_campaign: z.string().min(1).optional(),
  utm_content: z.string().min(1).optional(),
  utm_term: z.string().min(1).optional(),
  utm_id: z.string().min(1).optional(),
  campaign_id: z.string().min(1).optional(),
  adset_id: z.string().min(1).optional(),
  ad_id: z.string().min(1).optional(),
  landing_page: z.string().url().optional(),
  referrer: z.string().url().optional(),
});

const browserSchema = z.object({
  page_url: z.string().url().optional(),
  user_agent: z.string().min(1).optional(),
  /** Only populated when legitimately available server-side (e.g. from the
   * request that reached the Gateway) — never derived/guessed. */
  ip_address: z.string().min(1).optional(),
  locale: z.string().min(1).optional(),
});

const contentItemSchema = z.object({
  id: z.string().min(1),
  quantity: z.number().int().positive().optional(),
  item_price: z.number().nonnegative().optional(),
});

const commerceSchema = z.object({
  currency: z.string().length(3).optional(),
  presentment_currency: z.string().length(3).optional(),
  value: z.number().nonnegative().optional(),
  order_id: z.string().min(1).optional(),
  checkout_token: z.string().min(1).optional(),
  cart_token: z.string().min(1).optional(),
  content_type: z.enum(["product", "product_group"]).optional(),
  content_ids: z.array(z.string().min(1)).optional(),
  contents: z.array(contentItemSchema).optional(),
  num_items: z.number().int().nonnegative().optional(),
});

const consentSchema = z.object({
  analyticsProcessingAllowed: z.boolean().optional(),
  marketingAllowed: z.boolean().optional(),
  preferencesProcessingAllowed: z.boolean().optional(),
  saleOfDataAllowed: z.boolean().optional(),
});

const sourceSchema = z.object({
  origin: z.enum(["browser", "server", "webhook"]),
  pixel_type: z.enum(["app_pixel", "custom_pixel"]).optional(),
  ingested_via: z.string().min(1).optional(),
});

const metadataSchema = z
  .object({
    environment: z.enum(["development", "staging", "production"]),
    correlation_id: z.string().min(1).optional(),
    /** Set by the Gateway on receipt, never trusted from the client. */
    received_at: z.string().datetime().optional(),
  })
  .catchall(z.unknown());

export const trackingEventV1Schema = z
  .object({
    schema_version: z.literal("1.0"),
    event_id: z.string().min(1),
    event_name: z.enum(TRACKING_EVENT_NAMES),
    event_time: z.string().datetime(),
    shop: shopSchema,
    identity: identitySchema,
    attribution: attributionSchema.default({}),
    browser: browserSchema.default({}),
    commerce: commerceSchema.default({}),
    consent: consentSchema.default({}),
    source: sourceSchema,
    metadata: metadataSchema,
  })
  .superRefine((event, ctx) => {
    if (SERVER_ONLY_EVENT_NAMES.has(event.event_name) && event.source.origin === "browser") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `event_name "${event.event_name}" cannot originate from source.origin "browser" (webhook-first purchase rule)`,
        path: ["source", "origin"],
      });
    }
  });

export type TrackingEventV1 = z.infer<typeof trackingEventV1Schema>;
