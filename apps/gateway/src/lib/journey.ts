import { and, asc, eq, or } from "drizzle-orm";
import { schema, type Database } from "@tracking/db";
import { resolveSessionForCheckoutToken } from "./checkoutTracking.js";

export type IdentityLinkRow = typeof schema.identityLinks.$inferSelect;
export type AttributionTouchRow = typeof schema.attributionTouches.$inferSelect;

/**
 * Returns every Identity Graph edge touching this node, checking BOTH
 * sides of the stored (entity_a, entity_b) pair — an edge is written once
 * (see lib/transfer.ts / lib/attribution.ts), never duplicated in the
 * reverse direction, so a lookup that only checked entity_a would silently
 * miss half of them (docs/ARCHITECTURE.md section E: typed edges, not a
 * single fused ID).
 */
export async function findLinksForEntity(
  db: Database,
  entityType: string,
  entityValue: string,
): Promise<IdentityLinkRow[]> {
  return db
    .select()
    .from(schema.identityLinks)
    .where(
      or(
        and(eq(schema.identityLinks.entityAType, entityType), eq(schema.identityLinks.entityAValue, entityValue)),
        and(eq(schema.identityLinks.entityBType, entityType), eq(schema.identityLinks.entityBValue, entityValue)),
      ),
    );
}

/** Given an edge and the node already known, returns the OTHER end. */
function otherSide(
  edge: IdentityLinkRow,
  knownType: string,
  knownValue: string,
): { type: string; value: string } {
  if (edge.entityAType === knownType && edge.entityAValue === knownValue) {
    return { type: edge.entityBType, value: edge.entityBValue };
  }
  return { type: edge.entityAType, value: edge.entityAValue };
}

export interface LinkedIdentity {
  trackingId: string;
  viaSessionId: string;
  linkedSessionId: string;
  confidence: IdentityLinkRow["confidence"];
  source: string;
}

export interface JourneyResult {
  /** Every `tracking_id` folded into this journey — the starting one plus
   * any reached by following DETERMINISTIC `session_id <-> session_id`
   * edges (the cross-domain bridge). */
  trackingIds: string[];
  /** The edges that were actually followed to reach the extra tracking_ids
   * above, each carrying its own confidence level — never silently
   * upgraded or hidden (docs/ARCHITECTURE.md section E: a PROBABILISTIC
   * link, if one is ever introduced, must always be shown as such). */
  linkedIdentities: LinkedIdentity[];
  /** Every attribution touch across all of the tracking_ids above,
   * chronologically ordered — this is the reconstructed journey. */
  touches: AttributionTouchRow[];
}

/**
 * Walks the Identity Graph outward from a starting `tracking_id`,
 * following `session_id <-> session_id` DETERMINISTIC edges (the
 * cross-domain bridge, docs/ARCHITECTURE.md sections C/E) to find every
 * OTHER `tracking_id` this visitor is also known to be, then merges every
 * attribution touch from all of them into one chronological journey —
 * this is what makes the spec's own worked example (Meta ad day 1 on
 * Store A -> Direct day 3 -> Meta ad day 5 -> Purchase on Store B, day 5)
 * reconstructable from data that actually lives in two separate
 * first-party cookie spaces (Store A and Store B are different domains).
 *
 * This is a bounded breadth-first walk, not a hardcoded single hop: today
 * only one edge type chains (`session_id <-> session_id`), so it always
 * terminates after one hop in practice, but the traversal itself doesn't
 * assume that — it stops naturally once no new `tracking_id` is
 * discovered. That keeps it correct if a future edge type (e.g. an
 * eventual, explicitly-audited PROBABILISTIC link) adds another hop,
 * without needing to rewrite this function.
 *
 * Never fabricates a `tracking_id` for the other side of an edge: if a
 * linked `session_id` isn't itself attached to any known session (should
 * not happen for edges this Gateway wrote itself, but defensive against a
 * partially-seeded or corrupted graph), that edge is simply not followed
 * further rather than guessed at.
 */
export async function reconstructJourneyByTrackingId(
  db: Database,
  startTrackingId: string,
): Promise<JourneyResult> {
  const visitedTrackingIds = new Set<string>([startTrackingId]);
  const linkedIdentities: LinkedIdentity[] = [];
  // An edge is undirected in how it's stored and queried (findLinksForEntity
  // matches either side), so a two-node component gets visited from BOTH
  // ends as the BFS expands — without this guard the same edge would be
  // reported twice (once discovered from each side). Tracked by `link_id`
  // so each edge contributes exactly one `LinkedIdentity` regardless of
  // which end of it was reached first.
  const visitedLinkIds = new Set<string>();
  const frontier: string[] = [startTrackingId];

  while (frontier.length > 0) {
    const trackingId = frontier.shift();
    if (trackingId === undefined) break;

    const sessionsForTrackingId = await db
      .select({ sessionId: schema.sessions.sessionId })
      .from(schema.sessions)
      .where(eq(schema.sessions.trackingId, trackingId));

    for (const { sessionId } of sessionsForTrackingId) {
      const edges = await findLinksForEntity(db, "session_id", sessionId);

      for (const edge of edges) {
        if (visitedLinkIds.has(edge.linkId)) continue;

        const other = otherSide(edge, "session_id", sessionId);
        if (other.type !== "session_id") continue; // only session<->session edges chain a journey today

        const [otherSession] = await db
          .select({ trackingId: schema.sessions.trackingId })
          .from(schema.sessions)
          .where(eq(schema.sessions.sessionId, other.value))
          .limit(1);
        if (!otherSession) continue;

        visitedLinkIds.add(edge.linkId);
        linkedIdentities.push({
          trackingId: otherSession.trackingId,
          viaSessionId: sessionId,
          linkedSessionId: other.value,
          confidence: edge.confidence,
          source: edge.source,
        });

        if (!visitedTrackingIds.has(otherSession.trackingId)) {
          visitedTrackingIds.add(otherSession.trackingId);
          frontier.push(otherSession.trackingId);
        }
      }
    }
  }

  const touchRowsByTrackingId = await Promise.all(
    Array.from(visitedTrackingIds).map((trackingId) =>
      db
        .select()
        .from(schema.attributionTouches)
        .where(eq(schema.attributionTouches.trackingId, trackingId))
        .orderBy(asc(schema.attributionTouches.occurredAt)),
    ),
  );

  const touches = touchRowsByTrackingId
    .flat()
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  return {
    trackingIds: Array.from(visitedTrackingIds),
    linkedIdentities,
    touches,
  };
}

export type JourneyByOrderResult =
  | { status: "order_not_found"; orderId: string }
  | { status: "no_checkout_correlation"; orderId: string }
  | { status: "checkout_not_tracked"; orderId: string; checkoutToken: string }
  | { status: "session_not_tracked"; orderId: string; checkoutToken: string; sessionId: string }
  | {
      status: "ok";
      orderId: string;
      checkoutToken: string;
      sessionId: string;
      trackingId: string;
      journey: JourneyResult;
    };

/**
 * The entry point matching the spec's own debugging requirement ("Journey
 * Inspector... a partir de order_id"): resolves
 * `order_id -> checkout_token -> session_id (Store B) -> tracking_id`,
 * then delegates to `reconstructJourneyByTrackingId` to pull in Store A's
 * touches too, via the cross-domain identity edge.
 *
 * Every point where this chain can legitimately be broken is its own
 * explicit, named status rather than a caught exception or a silently
 * empty/partial journey — an order with no `checkout_token`, a
 * `checkout_token` the Web Pixel never reported (see
 * lib/checkoutTracking.ts), or a session the Gateway has no record of are
 * all real, expected outcomes (ad blockers, JS disabled, consent
 * declined, or a race between the webhook and the pixel), not bugs to be
 * papered over with a fabricated link.
 */
export async function reconstructJourneyByOrderId(
  db: Database,
  orderId: string,
): Promise<JourneyByOrderResult> {
  const [order] = await db.select().from(schema.orders).where(eq(schema.orders.orderId, orderId)).limit(1);
  if (!order) return { status: "order_not_found", orderId };

  const checkoutToken = order.checkoutToken;
  if (!checkoutToken) return { status: "no_checkout_correlation", orderId };

  const resolved = await resolveSessionForCheckoutToken(db, checkoutToken);
  if (resolved.status === "checkout_not_tracked") {
    return { status: "checkout_not_tracked", orderId, checkoutToken };
  }
  if (resolved.status === "session_not_tracked") {
    return { status: "session_not_tracked", orderId, checkoutToken, sessionId: resolved.sessionId };
  }

  const journey = await reconstructJourneyByTrackingId(db, resolved.trackingId);
  return {
    status: "ok",
    orderId,
    checkoutToken,
    sessionId: resolved.sessionId,
    trackingId: resolved.trackingId,
    journey,
  };
}
