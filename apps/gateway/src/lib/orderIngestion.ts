import { z } from "zod";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@tracking/db";
import type { TrackingEventName } from "@tracking/schema";
import { recordEvent } from "./eventRegistry.js";
import { resolveSessionForCheckoutToken } from "./checkoutTracking.js";
import { normalizeMetaUserData } from "./metaNormalization.js";

/**
 * Defensive, partial schema for the Shopify Order webhook payload — only
 * the fields this Gateway actually uses. Money fields are kept as the
 * strings Shopify sends them as (e.g. "49.90") end-to-end, all the way
 * into the `numeric` Postgres columns, to avoid any floating-point
 * rounding of currency amounts.
 *
 * KNOWN OPEN QUESTION (documented, not resolved by assumption — see
 * docs/PHASE_LOG.md Phase 7): community reports describe conflicting
 * information about `checkout_token`/`cart_token` deprecation on the Order
 * object; the official changelog only confirms a new `cartToken` GraphQL
 * field (API 2026-07) without confirming REST deprecation. This schema
 * therefore accepts EITHER field and prefers `checkout_token`, and the
 * correlation is treated as best-effort — a missing value never blocks
 * ingestion, it just means this order can't be joined back to a
 * `checkouts` row (and, transitively, to attribution) by that path.
 */
const moneySchema = z.object({ amount: z.string(), currency_code: z.string() });

/**
 * Field names verified against Shopify's Order resource
 * (shopify.dev/docs/api/admin-rest/2026-01/resources/order, Phase 10
 * research) — `email`/`phone` top-level, `customer.{email,phone,
 * first_name,last_name}`, `billing_address.{first_name,last_name,city,
 * province_code,zip,country_code}`. No `.email()` format validation on
 * purpose: a malformed value here must never block order ingestion (the
 * established pattern in this file) — it will simply fail to match
 * anything meaningful once hashed for Meta, which is an honest, harmless
 * outcome, not something worth rejecting the whole webhook over.
 */
const orderCustomerSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String).optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
});

const orderBillingAddressSchema = z.object({
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  province_code: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
});

const orderWebhookPayloadSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  checkout_token: z.string().nullable().optional(),
  cart_token: z.string().nullable().optional(),
  financial_status: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  total_price: z.string().nullable().optional(),
  total_price_set: z
    .object({ shop_money: moneySchema, presentment_money: moneySchema })
    .nullable()
    .optional(),
  created_at: z.string().nullable().optional(),
  cancelled_at: z.string().nullable().optional(),
  // Present only when the installed app has the relevant Protected
  // Customer Data scopes approved (docs/ARCHITECTURE.md section I) —
  // otherwise Shopify sends `null` here, which this schema already
  // treats as legitimate absence, not an error.
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  customer: orderCustomerSchema.nullable().optional(),
  billing_address: orderBillingAddressSchema.nullable().optional(),
});

const refundWebhookPayloadSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  order_id: z.union([z.number(), z.string()]).transform(String),
  created_at: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  transactions: z.array(z.object({ amount: z.string() })).optional(),
});

export type OrderWebhookPayload = z.infer<typeof orderWebhookPayloadSchema>;
export type RefundWebhookPayload = z.infer<typeof refundWebhookPayloadSchema>;

export const OrderWebhookTopic = {
  Create: "orders/create",
  Paid: "orders/paid",
  Cancelled: "orders/cancelled",
} as const;
export type OrderWebhookTopicValue = (typeof OrderWebhookTopic)[keyof typeof OrderWebhookTopic];

const TOPIC_TO_EVENT_NAME: Record<OrderWebhookTopicValue, TrackingEventName> = {
  "orders/create": "order_created",
  "orders/paid": "order_paid",
  "orders/cancelled": "order_cancelled",
};

const TOPIC_TO_STATE: Record<OrderWebhookTopicValue, (typeof schema.purchaseStateEnum.enumValues)[number]> = {
  "orders/create": "ORDER_CREATED",
  "orders/paid": "PAID",
  "orders/cancelled": "CANCELLED",
};

export function parseOrderWebhookPayload(raw: unknown): OrderWebhookPayload {
  return orderWebhookPayloadSchema.parse(raw);
}

export function parseRefundWebhookPayload(raw: unknown): RefundWebhookPayload {
  return refundWebhookPayloadSchema.parse(raw);
}

/**
 * Deterministic event_id shared by ANY delivery describing the same
 * logical order state — including Shopify's own webhook retries and this
 * Gateway's future queue retries (spec section 13/23: Purchase idempotency).
 */
export function orderEventId(topic: OrderWebhookTopicValue, shopId: string, orderId: string): string {
  return `${TOPIC_TO_EVENT_NAME[topic]}:${shopId}:${orderId}`;
}

export function refundEventId(shopId: string, refundId: string): string {
  return `refund_created:${shopId}:${refundId}`;
}

/**
 * Upserts the `orders` row and records the corresponding TrackingEventV1
 * in the event archive/dedup ledger. This is Phase 7 scope: persistence +
 * idempotent event recording. Building the Meta CAPI Purchase itself from
 * this data is Phase 9/10 (Order → Attribution Reconciliation, spec
 * section 24) — deliberately not done here.
 */
export async function ingestOrderWebhook(
  db: Database,
  params: { shopId: string; topic: OrderWebhookTopicValue; payload: OrderWebhookPayload },
): Promise<void> {
  const { shopId, topic, payload } = params;
  const checkoutToken = payload.checkout_token ?? payload.cart_token ?? undefined;

  const shopMoney = payload.total_price_set?.shop_money;
  const presentmentMoney = payload.total_price_set?.presentment_money;

  await db
    .insert(schema.orders)
    .values({
      orderId: payload.id,
      shopId,
      checkoutToken,
      financialStatus: payload.financial_status ?? undefined,
      currency: shopMoney?.currency_code ?? payload.currency ?? undefined,
      presentmentCurrency: presentmentMoney?.currency_code ?? undefined,
      totalAmount: shopMoney?.amount ?? payload.total_price ?? undefined,
      state: TOPIC_TO_STATE[topic],
      paidAt: topic === "orders/paid" ? new Date() : undefined,
      cancelledAt: topic === "orders/cancelled" ? new Date() : undefined,
    })
    .onConflictDoUpdate({
      target: schema.orders.orderId,
      set: {
        financialStatus: payload.financial_status ?? undefined,
        state: TOPIC_TO_STATE[topic],
        checkoutToken,
        paidAt: topic === "orders/paid" ? new Date() : undefined,
        cancelledAt: topic === "orders/cancelled" ? new Date() : undefined,
      },
    });

  await backfillCustomerIdentityFromOrder(db, { orderId: payload.id, checkoutToken, payload });

  const eventId = orderEventId(topic, shopId, payload.id);
  await recordEvent(db, {
    schema_version: "1.0",
    event_id: eventId,
    event_name: TOPIC_TO_EVENT_NAME[topic],
    event_time: payload.created_at ?? new Date().toISOString(),
    shop: { shop_id: shopId, role: "checkout" },
    // Webhook-originated events have no first-party identity of their own
    // — the Order → Attribution Reconciliation step (Phase 9) is what
    // joins this to a tracking_id/session_id via checkout_token, not the
    // ingestion step itself. Using nil UUIDs here would fabricate a link
    // that doesn't exist yet, so a placeholder well-known "unresolved"
    // identity is used instead and reconciliation resolves it later.
    identity: { tracking_id: UNRESOLVED_IDENTITY, session_id: UNRESOLVED_IDENTITY },
    attribution: {},
    browser: {},
    commerce: {
      order_id: payload.id,
      checkout_token: checkoutToken,
      currency: shopMoney?.currency_code ?? payload.currency ?? undefined,
      value: shopMoney?.amount !== undefined ? Number(shopMoney.amount) : undefined,
    },
    consent: {},
    source: { origin: "webhook", ingested_via: "shopify_admin_webhook" },
    metadata: { environment: "development" },
  });
}

/**
 * Closes the `order_id <-> email_hash`/`phone_hash` Identity Graph edge
 * that docs/ARCHITECTURE.md section E lists but Phase 8 explicitly left
 * unimplemented ("depende das funções de normalização/hashing do Meta
 * CAPI, Fase 10" — see docs/PHASE_LOG.md Phase 8 pendencies). Now that
 * `lib/metaNormalization.ts` exists, this order webhook is the ONE place
 * that ever sees the raw customer email/phone Shopify sends — so hashing
 * happens right here, at the moment of receipt, and only the hash is
 * persisted. Raw values never touch any table.
 *
 * Requires the `checkout_token -> session_id -> tracking_id` chain to
 * already resolve (via `resolveSessionForCheckoutToken`, the same lookup
 * `reconstructJourneyByOrderId` uses): with no resolvable `tracking_id`
 * there is no `identity_private` row to attach the hash to, and this
 * function deliberately does nothing rather than invent one. That's a
 * real, expected outcome (checkout never tracked by the pixel, or no
 * `checkout_token` at all on this order) — Phase 9's journey
 * reconstruction already treats it as such.
 */
export async function backfillCustomerIdentityFromOrder(
  db: Database,
  params: { orderId: string; checkoutToken: string | undefined; payload: OrderWebhookPayload },
): Promise<void> {
  const { orderId, checkoutToken, payload } = params;
  if (!checkoutToken) return;

  const resolved = await resolveSessionForCheckoutToken(db, checkoutToken);
  if (resolved.status !== "ok") return;

  const email = payload.customer?.email ?? payload.email ?? undefined;
  const phone = payload.customer?.phone ?? undefined;
  const normalized = normalizeMetaUserData({ email, phone });
  if (!normalized.em && !normalized.ph) return; // nothing legitimately available to persist

  const identityPrivatePatch: { emailHash?: string; phoneHash?: string } = {};
  if (normalized.em) identityPrivatePatch.emailHash = normalized.em;
  if (normalized.ph) identityPrivatePatch.phoneHash = normalized.ph;

  await db
    .insert(schema.identityPrivate)
    .values({ trackingId: resolved.trackingId, ...identityPrivatePatch })
    .onConflictDoUpdate({
      target: schema.identityPrivate.trackingId,
      // Only overwrite a field this delivery actually carried a value
      // for — a later webhook that happens to omit email (e.g. Protected
      // Customer Data scope revoked) must never clobber a hash already on
      // file from an earlier one.
      set: identityPrivatePatch,
    });

  const edges: Array<["email_hash" | "phone_hash", string]> = [];
  if (normalized.em) edges.push(["email_hash", normalized.em]);
  if (normalized.ph) edges.push(["phone_hash", normalized.ph]);

  for (const [entityType, value] of edges) {
    await db
      .insert(schema.identityLinks)
      .values({
        entityAType: "order_id",
        entityAValue: orderId,
        entityBType: entityType,
        entityBValue: value,
        confidence: "DETERMINISTIC",
        source: "shopify_order_webhook",
      })
      .onConflictDoNothing();
  }
}

export async function ingestRefundWebhook(
  db: Database,
  params: { shopId: string; payload: RefundWebhookPayload },
): Promise<void> {
  const { shopId, payload } = params;

  const refundedAmount = payload.transactions
    ?.map((t) => Number(t.amount))
    .reduce((sum, n) => sum + n, 0);

  await db
    .insert(schema.refunds)
    .values({
      refundId: payload.id,
      orderId: payload.order_id,
      amount: refundedAmount !== undefined ? String(refundedAmount) : undefined,
      reason: payload.note ?? undefined,
    })
    .onConflictDoNothing({ target: schema.refunds.refundId });

  const [order] = await db
    .select({ totalAmount: schema.orders.totalAmount })
    .from(schema.orders)
    .where(eq(schema.orders.orderId, payload.order_id))
    .limit(1);

  if (order) {
    const isFullRefund =
      refundedAmount !== undefined &&
      order.totalAmount !== null &&
      refundedAmount >= Number(order.totalAmount);

    await db
      .update(schema.orders)
      .set({ state: isFullRefund ? "REFUNDED" : "PARTIALLY_REFUNDED" })
      .where(eq(schema.orders.orderId, payload.order_id));
  }

  await recordEvent(db, {
    schema_version: "1.0",
    event_id: refundEventId(shopId, payload.id),
    event_name: "refund_created",
    event_time: payload.created_at ?? new Date().toISOString(),
    shop: { shop_id: shopId, role: "checkout" },
    identity: { tracking_id: UNRESOLVED_IDENTITY, session_id: UNRESOLVED_IDENTITY },
    attribution: {},
    browser: {},
    commerce: {
      order_id: payload.order_id,
      value: refundedAmount,
    },
    consent: {},
    source: { origin: "webhook", ingested_via: "shopify_admin_webhook" },
    metadata: { environment: "development" },
  });
}

/** Well-known nil UUID marking "identity not yet resolved" on
 * webhook-originated events. Never a real visitor/session — Phase 9's
 * reconciliation step is what fills in the true identity via
 * checkout_token, and until then this makes "unattributed" queryable
 * rather than silently absent. */
export const UNRESOLVED_IDENTITY = "00000000-0000-0000-0000-000000000000";
