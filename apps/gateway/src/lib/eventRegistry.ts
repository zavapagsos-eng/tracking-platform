import { eq, sql } from "drizzle-orm";
import { schema, type Database } from "@tracking/db";
import type { TrackingEventV1 } from "@tracking/schema";

export type RecordEventResult =
  | { status: "stored" }
  | { status: "duplicate"; reason: "already_ingested" };

/**
 * Persists a validated event into the raw archive (`events`) and updates
 * the local dedup ledger (`event_registry`) — this ledger is consulted
 * BEFORE anything is ever sent to Meta, independent of Meta's own 48h
 * Pixel/CAPI dedup window (spec section 13).
 *
 * Idempotent on `event_id`: a retried/duplicated ingestion (client retry,
 * at-least-once delivery) never creates a second row and never regresses
 * `meta_sent` once it has been set true downstream (Phase 10/11).
 */
export async function recordEvent(
  db: Database,
  event: TrackingEventV1,
): Promise<RecordEventResult> {
  const insertedEvents = await db
    .insert(schema.events)
    .values({
      eventId: event.event_id,
      eventName: event.event_name,
      schemaVersion: event.schema_version,
      trackingId: event.identity.tracking_id,
      sessionId: event.identity.session_id,
      shopId: event.shop.shop_id,
      sourceOrigin: event.source.origin,
      payload: event,
      validationStatus: "valid",
    })
    .onConflictDoNothing({ target: schema.events.eventId })
    .returning({ eventId: schema.events.eventId });

  const isNewEvent = insertedEvents.length > 0;

  const receivedFlags = {
    browserReceived: event.source.origin === "browser",
    serverReceived: event.source.origin === "server" || event.source.origin === "webhook",
  };

  await db
    .insert(schema.eventRegistry)
    .values({
      eventId: event.event_id,
      eventName: event.event_name,
      trackingId: event.identity.tracking_id,
      sessionId: event.identity.session_id,
      sourceOrigin: event.source.origin,
      browserReceived: receivedFlags.browserReceived,
      serverReceived: receivedFlags.serverReceived,
      status: "pending",
    })
    .onConflictDoUpdate({
      target: schema.eventRegistry.eventId,
      set: {
        // OR the new signal in — a browser event arriving after a server
        // event (or vice versa) enriches the registry, it never regresses it.
        browserReceived: sql`${schema.eventRegistry.browserReceived} OR ${receivedFlags.browserReceived}`,
        serverReceived: sql`${schema.eventRegistry.serverReceived} OR ${receivedFlags.serverReceived}`,
      },
    });

  return isNewEvent ? { status: "stored" } : { status: "duplicate", reason: "already_ingested" };
}

export async function getEventRegistryEntry(db: Database, eventId: string) {
  const [row] = await db
    .select()
    .from(schema.eventRegistry)
    .where(eq(schema.eventRegistry.eventId, eventId))
    .limit(1);
  return row;
}

/**
 * A narrower sibling of `recordEvent()` above, for a Meta-facing event
 * that has no TrackingEventV1 counterpart of its own — Meta's standard
 * event name "Purchase" (docs/ARCHITECTURE.md section F/9, Phase 10's
 * `purchase:{shop_id}:{order_id}` event_id) is not one of this project's
 * internal `TRACKING_EVENT_NAMES` (our own domain event for the same
 * moment is `order_paid`). Rather than force "Purchase" into that enum
 * just to reuse `recordEvent()`, this writes directly to the registry —
 * `event_registry` only, no raw `events` archive row, since there is no
 * TrackingEventV1 payload for it to archive.
 */
export async function ensureEventRegistryRow(
  db: Database,
  params: {
    eventId: string;
    eventName: string;
    trackingId: string;
    sessionId: string;
    sourceOrigin: (typeof schema.eventSourceEnum.enumValues)[number];
  },
): Promise<void> {
  await db
    .insert(schema.eventRegistry)
    .values({
      eventId: params.eventId,
      eventName: params.eventName,
      trackingId: params.trackingId,
      sessionId: params.sessionId,
      sourceOrigin: params.sourceOrigin,
      status: "pending",
    })
    .onConflictDoNothing({ target: schema.eventRegistry.eventId });
}

/** Marks an event_registry row as delivered to Meta — the local dedup
 * check every Meta send consults BEFORE calling out (spec section 13),
 * independent of Meta's own 48h Pixel/CAPI window. */
export async function markEventMetaSent(db: Database, eventId: string): Promise<void> {
  await db
    .update(schema.eventRegistry)
    .set({ metaSent: true })
    .where(eq(schema.eventRegistry.eventId, eventId));
}
