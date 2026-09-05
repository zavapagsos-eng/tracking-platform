import { eq } from "drizzle-orm";
import { schema, type Database } from "@tracking/db";
import { reconstructJourneyByOrderId, type JourneyByOrderResult, type AttributionTouchRow } from "./journey.js";
import { getCurrentMarketingConsent } from "./consent.js";
import { normalizeMetaUserData, type NormalizedMetaUserData } from "./metaNormalization.js";
import {
  sendMetaCapiEvent,
  type MetaCapiCredentials,
  type MetaCapiEvent,
  type MetaCapiSendResult,
} from "./metaCapiClient.js";
import { ensureEventRegistryRow, getEventRegistryEntry, markEventMetaSent } from "./eventRegistry.js";

/**
 * Deterministic, per docs/ARCHITECTURE.md section F ("Purchase: event_id
 * determinístico, derivado do order_id... nunca aleatório"). This is a
 * DIFFERENT namespace from `orderEventId()` in lib/orderIngestion.ts
 * (`order_paid:{shop_id}:{order_id}`, this project's own internal event
 * taxonomy) — "Purchase" is Meta's standard event name, shared between
 * whatever Pixel the merchant may also have firing client-side on the
 * order-status page and this server-side CAPI send, specifically so
 * Meta's own 48h dedup window matches the two.
 */
export function purchaseEventId(shopId: string, orderId: string): string {
  return `purchase:${shopId}:${orderId}`;
}

/** `touches` is already chronological (see lib/journey.ts) — walking from
 * the end finds the MOST RECENT non-null value, which is the signal
 * docs/ARCHITECTURE.md section D says to send to Meta ("fbc/fbp mais
 * recentes disponíveis na jornada"), independent of which attribution
 * model "wins" analytically. */
function mostRecentValue(touches: AttributionTouchRow[], field: "fbc" | "fbp"): string | undefined {
  for (let i = touches.length - 1; i >= 0; i -= 1) {
    const value = touches[i]![field];
    if (value) return value;
  }
  return undefined;
}

export type BuildPurchaseEventResult =
  | Exclude<JourneyByOrderResult, { status: "ok" }>
  | { status: "ok"; event: MetaCapiEvent; shopId: string; sessionId: string; trackingId: string };

/**
 * Assembles the Meta CAPI `Purchase` event for an order — this is Phase
 * 9's journey/attribution machinery plus Phase 10's normalization, wired
 * together, but stops short of deciding whether to actually send it
 * (that's `sendPurchaseToMeta` below, which adds the consent and dedup
 * gates). Every point where the underlying journey can't be resolved
 * passes straight through as the same named status
 * `reconstructJourneyByOrderId` already produces — never a fabricated
 * partial event.
 *
 * EXPLICIT SCOPE BOUNDARY (documented, not silently absent): `user_data`
 * here includes `em`/`ph` (from `identity_private`, backfilled by
 * lib/orderIngestion.ts's `backfillCustomerIdentityFromOrder`), `fbc`/
 * `fbp`, `client_ip_address`/`client_user_agent`, and `external_id`. It
 * does NOT include `fn`/`ln`/`ct`/`st`/`zp`/`country` — Shopify's Order
 * webhook does carry billing name/address (see lib/orderIngestion.ts),
 * but persisting it durably requires the same at-rest encryption
 * `identity_private.first_name_enc`/`last_name_enc`/`address_enc` were
 * designed for (docs/ARCHITECTURE.md section I), which is a security
 * infrastructure decision for Phase 15, not one to improvise here. EMQ is
 * therefore not yet fully maximized; tracked in docs/PHASE_LOG.md Phase 10
 * as a pending item rather than silently shipped as if it were complete.
 */
export async function buildPurchaseCapiEvent(db: Database, orderId: string): Promise<BuildPurchaseEventResult> {
  const journeyResult = await reconstructJourneyByOrderId(db, orderId);
  if (journeyResult.status !== "ok") return journeyResult;

  const [order] = await db.select().from(schema.orders).where(eq(schema.orders.orderId, orderId)).limit(1);
  if (!order) return { status: "order_not_found", orderId };

  const [sessionRow] = await db
    .select({
      ipAddress: schema.sessions.ipAddress,
      userAgent: schema.sessions.userAgent,
      landingPage: schema.sessions.landingPage,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.sessionId, journeyResult.sessionId))
    .limit(1);

  const [identityPrivateRow] = await db
    .select()
    .from(schema.identityPrivate)
    .where(eq(schema.identityPrivate.trackingId, journeyResult.trackingId))
    .limit(1);

  const fbc = mostRecentValue(journeyResult.journey.touches, "fbc");
  const fbp = mostRecentValue(journeyResult.journey.touches, "fbp");

  const passthrough = normalizeMetaUserData({
    fbc,
    fbp,
    clientIpAddress: sessionRow?.ipAddress ?? undefined,
    clientUserAgent: sessionRow?.userAgent ?? undefined,
    externalId: journeyResult.trackingId,
  });

  const userData: NormalizedMetaUserData = {
    ...passthrough,
    ...(identityPrivateRow?.emailHash ? { em: identityPrivateRow.emailHash } : {}),
    ...(identityPrivateRow?.phoneHash ? { ph: identityPrivateRow.phoneHash } : {}),
  };

  const eventTimeSource = order.paidAt ?? order.createdAt;
  const event: MetaCapiEvent = {
    event_name: "Purchase",
    event_time: Math.floor(eventTimeSource.getTime() / 1000),
    event_id: purchaseEventId(order.shopId, orderId),
    // Best-effort substitute for a literal "current page URL": there is
    // no browser page for a server-triggered webhook event, so the
    // checkout session's own landing_page (legitimately captured when
    // that browser session started) stands in — never a fabricated URL.
    event_source_url: sessionRow?.landingPage ?? undefined,
    action_source: "website",
    user_data: userData,
    custom_data: {
      currency: order.currency ?? undefined,
      value: order.totalAmount !== null ? Number(order.totalAmount) : undefined,
      order_id: orderId,
    },
  };

  return { status: "ok", event, shopId: order.shopId, sessionId: journeyResult.sessionId, trackingId: journeyResult.trackingId };
}

export type SendPurchaseResult =
  | Exclude<JourneyByOrderResult, { status: "ok" }>
  | { status: "consent_not_granted" }
  | { status: "already_sent" }
  | { status: "sent"; httpStatus: number }
  | { status: "http_error"; httpStatus: number; responseRedacted: unknown }
  | { status: "network_error"; error: string };

/**
 * The full send decision for one order's Purchase event — builds the
 * event, then applies, IN ORDER: (1) the local dedup gate (never re-send
 * something already marked `meta_sent`, regardless of the Meta 48h
 * window), (2) the marketing-consent gate (docs/ARCHITECTURE.md section
 * I's decision rule — "sem consentimento de marketing... não expedido ao
 * Meta"), only THEN (3) the actual HTTP call. Every outcome — including
 * both gates rejecting the send — is recorded: a consent/dedup skip is a
 * normal, expected result, not silently dropped.
 *
 * `meta_deliveries` gets one row per call to this function, whether the
 * send succeeded, failed, or was never attempted due to consent — full
 * delivery history is the point (docs/ARCHITECTURE.md ER diagram). A
 * proper retry/backoff counter across MULTIPLE calls is Phase 11 (queue)
 * scope, not implemented here.
 */
export async function sendPurchaseToMeta(
  db: Database,
  orderId: string,
  credentials: MetaCapiCredentials,
): Promise<SendPurchaseResult> {
  const built = await buildPurchaseCapiEvent(db, orderId);
  if (built.status !== "ok") return built;

  const eventId = built.event.event_id;

  await ensureEventRegistryRow(db, {
    eventId,
    eventName: "Purchase",
    trackingId: built.trackingId,
    sessionId: built.sessionId,
    sourceOrigin: "server",
  });

  const existing = await getEventRegistryEntry(db, eventId);
  if (existing?.metaSent) {
    return { status: "already_sent" };
  }

  const consent = await getCurrentMarketingConsent(db, { shopId: built.shopId, sessionId: built.sessionId });
  if (consent !== "granted") {
    return { status: "consent_not_granted" };
  }

  const result: MetaCapiSendResult = await sendMetaCapiEvent(built.event, credentials);

  await db.insert(schema.metaDeliveries).values({
    eventId,
    httpStatus: result.status === "network_error" ? undefined : result.httpStatus,
    responseRedacted: result.status === "network_error" ? { error: result.error } : result.responseRedacted,
    attemptCount: 1,
    deliveryStatus: result.status === "sent" ? "delivered" : "failed",
    // Snapshot of exactly what THIS attempt told Meta — see the column
    // comment on `metaDeliveries.valueSent` (packages/db/src/schema.ts) for
    // why this must never be re-derived from `orders` later.
    valueSent: built.event.custom_data?.value !== undefined ? String(built.event.custom_data.value) : undefined,
    currencySent: built.event.custom_data?.currency,
  });

  if (result.status === "sent") {
    await markEventMetaSent(db, eventId);
    return { status: "sent", httpStatus: result.httpStatus };
  }
  if (result.status === "http_error") {
    // `responseRedacted` (Meta's own JSON error body — no secrets, per
    // `sendMetaCapiEvent`'s own contract) is surfaced here, not just
    // persisted to `meta_deliveries`, so the Phase 11 queue worker can
    // classify retryable vs. permanent Meta errors (lib/metaErrorClassification.ts)
    // without re-querying the database for what this call already has in hand.
    return { status: "http_error", httpStatus: result.httpStatus, responseRedacted: result.responseRedacted };
  }
  return { status: "network_error", error: result.error };
}
