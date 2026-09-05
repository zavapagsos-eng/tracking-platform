import type { TrackingEventV1 } from "@tracking/schema";

/**
 * Fire-and-forget delivery to the Tracking Gateway's public ingestion
 * endpoint. Uses `fetch(..., { keepalive: true })` rather than
 * `browser.sendBeacon` — the latter is explicitly marked deprecated in
 * `@shopify/web-pixels-extension`'s own types, which recommend `fetch` +
 * `keepalive` instead (confirmed Phase 4, see docs/PHASE_LOG.md).
 *
 * Never throws, never retries client-side: a lost analytics beacon must
 * never block or slow down the storefront (spec section 50, "fail-open").
 * Durability past this point (dedup, retries, delivery guarantees) is the
 * Gateway/queue's job, not the pixel's.
 */
export function sendEvents(gatewayUrl: string, events: TrackingEventV1[]): void {
  if (events.length === 0) return;

  const body = events.length === 1 ? JSON.stringify(events[0]) : JSON.stringify({ events });

  void fetch(`${gatewayUrl.replace(/\/$/, "")}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // Intentionally swallowed — see fail-open note above.
  });
}
