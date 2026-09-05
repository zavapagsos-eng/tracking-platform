import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseTrackingEvent } from "@tracking/schema";
import { upsertVisitorAndSession } from "../lib/identity.js";
import { recordEvent } from "../lib/eventRegistry.js";
import { recordAttributionTouch } from "../lib/attribution.js";
import { recordCheckoutStart } from "../lib/checkoutTracking.js";
import { recordConsentIfPresent } from "../lib/consent.js";

/** Accepts either one event or a batch — the Web Pixel is expected to
 * batch when using `navigator.sendBeacon` (spec section 49: batching when
 * technically beneficial, fire-and-forget via keepalive/sendBeacon). */
const ingestBodySchema = z.union([
  z.object({ events: z.array(z.unknown()).min(1).max(50) }),
  z.record(z.unknown()), // a single raw event object
]);

interface RejectedEvent {
  index: number;
  errors: { path: string; message: string }[];
}

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/events", async (request, reply) => {
    const parsedBody = ingestBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: "invalid_request_body" });
    }

    const rawEvents: unknown[] =
      "events" in parsedBody.data && Array.isArray(parsedBody.data.events)
        ? parsedBody.data.events
        : [parsedBody.data];

    const accepted: string[] = [];
    const duplicates: string[] = [];
    const rejected: RejectedEvent[] = [];

    for (let index = 0; index < rawEvents.length; index += 1) {
      const result = parseTrackingEvent(rawEvents[index]);
      if (!result.ok) {
        rejected.push({
          index,
          errors: result.errors.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
        continue;
      }

      const event = result.event;

      // IP is taken from the request that reached the Gateway, never
      // inferred/guessed, and only when the field wasn't already supplied
      // by the caller (server-origin events may carry their own).
      const ipAddress = event.browser.ip_address ?? request.ip;

      try {
        const { isNewSession } = await upsertVisitorAndSession(app.db, {
          trackingId: event.identity.tracking_id,
          sessionId: event.identity.session_id,
          shopId: event.shop.shop_id,
          shopRole: event.shop.role,
          landingPage: event.attribution.landing_page,
          referrer: event.attribution.referrer,
          userAgent: event.browser.user_agent,
          ipAddress,
        });

        // Identity Graph inputs (Phase 8, docs/ARCHITECTURE.md section E/F):
        // one immutable attribution touch per session-start, plus the
        // session <-> checkout_token correlation the moment Store B's
        // pixel observes checkout beginning. Both are best-effort
        // enrichments of the event that's already being persisted below —
        // a failure here must never be allowed to reject the event itself
        // (fail-open, spec section 50), so they're guarded independently.
        if (isNewSession) {
          try {
            await recordAttributionTouch(app.db, {
              trackingId: event.identity.tracking_id,
              sessionId: event.identity.session_id,
              attribution: event.attribution,
            });
          } catch (err) {
            request.log.error({ err, eventId: event.event_id }, "failed to record attribution touch");
          }
        }

        if (event.event_name === "checkout_started") {
          try {
            await recordCheckoutStart(app.db, {
              sessionId: event.identity.session_id,
              shopId: event.shop.shop_id,
              event,
            });
          } catch (err) {
            request.log.error({ err, eventId: event.event_id }, "failed to record checkout start");
          }
        }

        // Consent gate input (Phase 10, docs/ARCHITECTURE.md section I):
        // recorded on EVERY event that carries a consent signal, not just
        // session-start — a visitor can accept/change a consent banner
        // mid-session, and the Meta-send gate always reads the MOST
        // RECENT snapshot, never a stale one from session start.
        try {
          await recordConsentIfPresent(app.db, {
            shopId: event.shop.shop_id,
            sessionId: event.identity.session_id,
            consent: event.consent,
          });
        } catch (err) {
          request.log.error({ err, eventId: event.event_id }, "failed to record consent");
        }

        const stored = await recordEvent(app.db, event);
        if (stored.status === "duplicate") {
          duplicates.push(event.event_id);
        } else {
          accepted.push(event.event_id);
        }
      } catch (err) {
        request.log.error({ err, eventId: event.event_id }, "failed to persist event");
        rejected.push({
          index,
          errors: [{ path: "", message: "internal_error" }],
        });
      }
    }

    // 202 Accepted even on partial failure — ingestion is fire-and-forget
    // from the storefront's point of view (fail-open, spec section 50);
    // the response body still reports per-event outcome for callers that
    // want to log/retry client-side.
    return reply.code(202).send({ accepted, duplicates, rejected });
  });
}
