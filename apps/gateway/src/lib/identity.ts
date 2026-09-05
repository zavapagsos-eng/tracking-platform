import { eq, sql } from "drizzle-orm";
import { schema, type Database } from "@tracking/db";

export interface SessionContext {
  trackingId: string;
  sessionId: string;
  shopId: string;
  shopRole: "storefront" | "checkout";
  landingPage?: string;
  referrer?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface UpsertResult {
  /** True the first time this `session_id` is ever seen — the caller uses
   * this as the "session just started" moment to record exactly one
   * attribution touch (see lib/attribution.ts), rather than one per event. */
  isNewSession: boolean;
}

/**
 * Idempotently persists the visitor/session identified by the client
 * (Web Pixel generates `tracking_id`/`session_id` itself using
 * `crypto.randomUUID()` and stores them in a first-party cookie — the
 * Gateway never invents or re-derives these from fingerprinting; see
 * docs/PHASE_LOG.md Phase 3 for this design decision). Safe to call on
 * every event without creating duplicate rows or clobbering `first_seen`.
 */
export async function upsertVisitorAndSession(db: Database, ctx: SessionContext): Promise<UpsertResult> {
  await db
    .insert(schema.visitors)
    .values({
      trackingId: ctx.trackingId,
      firstSeenShopId: ctx.shopId,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.visitors.trackingId,
      set: { lastSeenAt: new Date() },
    });

  // INSERT ... ON CONFLICT DO NOTHING (rather than DO UPDATE) so
  // `.returning()` tells us, unambiguously, whether this request is the
  // one that created the session row — the signal Phase 8 needs to record
  // exactly one attribution touch per session (see lib/attribution.ts)
  // instead of guessing from e.g. `event_name === "page_viewed"`, which
  // would miss sessions that start on a different first event.
  const inserted = await db
    .insert(schema.sessions)
    .values({
      sessionId: ctx.sessionId,
      trackingId: ctx.trackingId,
      shopId: ctx.shopId,
      shopRole: ctx.shopRole,
      landingPage: ctx.landingPage,
      referrer: ctx.referrer,
      userAgent: ctx.userAgent,
      ipAddress: ctx.ipAddress,
      lastEventAt: new Date(),
    })
    .onConflictDoNothing({ target: schema.sessions.sessionId })
    .returning({ sessionId: schema.sessions.sessionId });

  const isNewSession = inserted.length > 0;
  if (!isNewSession) {
    await db
      .update(schema.sessions)
      .set({ lastEventAt: new Date() })
      .where(eq(schema.sessions.sessionId, ctx.sessionId));
  }

  return { isNewSession };
}

/** Returns the tracking_id a session belongs to, or undefined if the
 * session is unknown to the Gateway (e.g. redeem called before any event
 * created the session — caller should treat this as UNATTRIBUTED, never
 * fabricate a link). */
export async function findTrackingIdBySession(
  db: Database,
  sessionId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ trackingId: schema.sessions.trackingId })
    .from(schema.sessions)
    .where(eq(schema.sessions.sessionId, sessionId))
    .limit(1);
  return row?.trackingId;
}

/** Cheap, injection-safe liveness check for DB connectivity. */
export async function pingDatabase(db: Database): Promise<boolean> {
  const result = await db.execute(sql`select 1 as ok`);
  return result.rows.length > 0;
}
