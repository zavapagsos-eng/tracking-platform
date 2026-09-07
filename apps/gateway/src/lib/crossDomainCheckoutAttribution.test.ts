import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase, type Database } from "@tracking/db";
import { upsertVisitorAndSession } from "./identity.js";
import { recordAttributionTouch } from "./attribution.js";
import { recordCheckoutStart } from "./checkoutTracking.js";
import {
  extractTrackingPlatformCartAttributes,
  linkCrossDomainCheckoutAttribution,
  parseOrderWebhookPayload,
} from "./orderIngestion.js";
import { reconstructJourneyByOrderId } from "./journey.js";
import { schema } from "@tracking/db";
import type { TrackingEventV1 } from "@tracking/schema";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://tracking:tracking_dev_pw@localhost:5432/tracking_test";

let db: Database;
let pool: ReturnType<typeof createDatabase>["pool"];

beforeAll(async () => {
  const created = createDatabase(TEST_DATABASE_URL);
  db = created.db;
  pool = created.pool;

  await pool.query(
    "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
  );
  await migrate(db, { migrationsFolder: new URL("../../../../packages/db/migrations", import.meta.url).pathname });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE identity_links, attribution_touches, checkouts, orders, sessions, visitors RESTART IDENTITY CASCADE",
  );
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("extractTrackingPlatformCartAttributes", () => {
  it("returns an empty object when note_attributes is absent or has no tp_ keys", () => {
    expect(extractTrackingPlatformCartAttributes(undefined)).toEqual({});
    expect(extractTrackingPlatformCartAttributes(null)).toEqual({});
    expect(extractTrackingPlatformCartAttributes([{ name: "gift_message", value: "hi" }])).toEqual({});
  });

  it("maps the four tp_ cart attribute keys, ignoring blank values", () => {
    const result = extractTrackingPlatformCartAttributes([
      { name: "tp_tracking_id", value: "abc-123" },
      { name: "tp_fbp", value: "fb.1.111.222" },
      { name: "tp_fbc", value: "" },
      { name: "tp_fbclid", value: undefined },
      { name: "unrelated_key", value: "ignored" },
    ]);
    expect(result).toEqual({ trackingId: "abc-123", fbp: "fb.1.111.222" });
  });
});

describe("linkCrossDomainCheckoutAttribution", () => {
  it("does nothing when there is no checkout_token", async () => {
    await linkCrossDomainCheckoutAttribution(db, {
      checkoutToken: undefined,
      payload: parseOrderWebhookPayload({ id: "cd1", note_attributes: [{ name: "tp_tracking_id", value: uuid(1) }] }),
    });
    const rows = await pool.query("SELECT * FROM identity_links");
    expect(rows.rowCount).toBe(0);
  });

  it("does nothing when the order has no tp_tracking_id cart attribute", async () => {
    const destTrackingId = uuid(1);
    const destSessionId = uuid(2);
    await upsertVisitorAndSession(db, { trackingId: destTrackingId, sessionId: destSessionId, shopId: "alpha-tactical", shopRole: "checkout" });
    await recordCheckoutStart(db, {
      sessionId: destSessionId,
      shopId: "alpha-tactical",
      event: { commerce: { checkout_token: "chk_no_tp" } } as unknown as TrackingEventV1,
    });

    await linkCrossDomainCheckoutAttribution(db, {
      checkoutToken: "chk_no_tp",
      payload: parseOrderWebhookPayload({ id: "cd2", checkout_token: "chk_no_tp" }),
    });

    const rows = await pool.query("SELECT * FROM identity_links");
    expect(rows.rowCount).toBe(0);
  });

  it("does nothing when the checkout_token was never tracked by the pixel", async () => {
    await linkCrossDomainCheckoutAttribution(db, {
      checkoutToken: "chk_untracked",
      payload: parseOrderWebhookPayload({
        id: "cd3",
        checkout_token: "chk_untracked",
        note_attributes: [{ name: "tp_tracking_id", value: uuid(1) }],
      }),
    });
    const rows = await pool.query("SELECT * FROM identity_links");
    expect(rows.rowCount).toBe(0);
  });

  it("does nothing when tp_tracking_id doesn't match any session this Gateway knows about", async () => {
    const destTrackingId = uuid(1);
    const destSessionId = uuid(2);
    await upsertVisitorAndSession(db, { trackingId: destTrackingId, sessionId: destSessionId, shopId: "alpha-tactical", shopRole: "checkout" });
    await recordCheckoutStart(db, {
      sessionId: destSessionId,
      shopId: "alpha-tactical",
      event: { commerce: { checkout_token: "chk_unknown_origin" } } as unknown as TrackingEventV1,
    });

    await linkCrossDomainCheckoutAttribution(db, {
      checkoutToken: "chk_unknown_origin",
      payload: parseOrderWebhookPayload({
        id: "cd4",
        checkout_token: "chk_unknown_origin",
        note_attributes: [{ name: "tp_tracking_id", value: uuid(999) }],
      }),
    });

    const rows = await pool.query("SELECT * FROM identity_links");
    expect(rows.rowCount).toBe(0);
  });

  it("does nothing when tp_tracking_id is already the destination's own tracking_id", async () => {
    const trackingId = uuid(1);
    const sessionId = uuid(2);
    await upsertVisitorAndSession(db, { trackingId, sessionId, shopId: "alpha-tactical", shopRole: "checkout" });
    await recordCheckoutStart(db, {
      sessionId,
      shopId: "alpha-tactical",
      event: { commerce: { checkout_token: "chk_same_identity" } } as unknown as TrackingEventV1,
    });

    await linkCrossDomainCheckoutAttribution(db, {
      checkoutToken: "chk_same_identity",
      payload: parseOrderWebhookPayload({
        id: "cd5",
        checkout_token: "chk_same_identity",
        note_attributes: [{ name: "tp_tracking_id", value: trackingId }],
      }),
    });

    const rows = await pool.query("SELECT * FROM identity_links");
    expect(rows.rowCount).toBe(0);
  });

  it("bridges the Hub origin session to the destination checkout session, and the merged journey then surfaces Hub's own fbc/fbp for the order", async () => {
    // Hub side: the customer clicked a Meta ad, our pixel recorded the
    // touch under Hub's own tracking_id/session_id.
    const hubTrackingId = uuid(1);
    const hubSessionId = uuid(2);
    await upsertVisitorAndSession(db, { trackingId: hubTrackingId, sessionId: hubSessionId, shopId: "hub", shopRole: "storefront" });
    await recordAttributionTouch(db, {
      trackingId: hubTrackingId,
      sessionId: hubSessionId,
      attribution: { fbclid: "fbclid123", fbc: "fb.1.111.hubfbc", fbp: "fb.1.111.hubfbp" },
    });

    // Destination side: "Smart Order Router" redirected the customer to a
    // brand-new checkout on Alpha Tactical — a first-ever visit to that
    // domain, so its own session has no attribution touches of its own.
    const destTrackingId = uuid(3);
    const destSessionId = uuid(4);
    await upsertVisitorAndSession(db, { trackingId: destTrackingId, sessionId: destSessionId, shopId: "alpha-tactical", shopRole: "checkout" });
    await recordCheckoutStart(db, {
      sessionId: destSessionId,
      shopId: "alpha-tactical",
      event: { commerce: { checkout_token: "chk_bridge", cart_token: "cart_bridge" } } as unknown as TrackingEventV1,
    });

    const payload = parseOrderWebhookPayload({
      id: "order_bridge",
      checkout_token: "chk_bridge",
      note_attributes: [
        { name: "tp_tracking_id", value: hubTrackingId },
        { name: "tp_fbp", value: "fb.1.111.hubfbp" },
        { name: "tp_fbc", value: "fb.1.111.hubfbc" },
        { name: "tp_fbclid", value: "fbclid123" },
      ],
    });

    await linkCrossDomainCheckoutAttribution(db, { checkoutToken: "chk_bridge", payload });

    const edge = await pool.query(
      "SELECT * FROM identity_links WHERE entity_a_type = 'session_id' AND entity_a_value = $1 AND entity_b_type = 'session_id' AND entity_b_value = $2",
      [destSessionId, hubSessionId],
    );
    expect(edge.rowCount).toBe(1);
    expect(edge.rows[0].confidence).toBe("DETERMINISTIC");
    expect(edge.rows[0].source).toBe("cross_domain_checkout_cart_attributes");

    // Insert the order row so reconstructJourneyByOrderId can resolve it end to end.
    await db.insert(schema.orders).values({ orderId: "order_bridge", shopId: "alpha-tactical", checkoutToken: "chk_bridge" });

    const journey = await reconstructJourneyByOrderId(db, "order_bridge");
    expect(journey.status).toBe("ok");
    if (journey.status !== "ok") throw new Error("unreachable");

    // The destination's own tracking_id is what the order resolves to directly...
    expect(journey.trackingId).toBe(destTrackingId);
    // ...but the merged journey now also includes Hub's tracking_id via the bridge...
    expect(journey.journey.trackingIds).toEqual(expect.arrayContaining([destTrackingId, hubTrackingId]));
    // ...and therefore Hub's own fbc/fbp touch is visible in the merged touches
    // (this is exactly what lib/metaCapiPurchase.ts's mostRecentValue() reads from).
    const fbcValues = journey.journey.touches.map((t) => t.fbc).filter(Boolean);
    const fbpValues = journey.journey.touches.map((t) => t.fbp).filter(Boolean);
    expect(fbcValues).toContain("fb.1.111.hubfbc");
    expect(fbpValues).toContain("fb.1.111.hubfbp");
  });

  it("also records a defensive attribution_touches row from the cart's own fbp/fbc, tied to the Hub tracking_id", async () => {
    const hubTrackingId = uuid(1);
    const hubSessionId = uuid(2);
    await upsertVisitorAndSession(db, { trackingId: hubTrackingId, sessionId: hubSessionId, shopId: "hub", shopRole: "storefront" });
    // Note: no recordAttributionTouch call here — Hub's own pixel touch is
    // deliberately missing/late, so the only signal comes from the cart attribute.

    const destTrackingId = uuid(3);
    const destSessionId = uuid(4);
    await upsertVisitorAndSession(db, { trackingId: destTrackingId, sessionId: destSessionId, shopId: "rugged-destino", shopRole: "checkout" });
    await recordCheckoutStart(db, {
      sessionId: destSessionId,
      shopId: "rugged-destino",
      event: { commerce: { checkout_token: "chk_defensive" } } as unknown as TrackingEventV1,
    });

    await linkCrossDomainCheckoutAttribution(db, {
      checkoutToken: "chk_defensive",
      payload: parseOrderWebhookPayload({
        id: "order_defensive",
        checkout_token: "chk_defensive",
        note_attributes: [
          { name: "tp_tracking_id", value: hubTrackingId },
          { name: "tp_fbp", value: "fb.1.222.onlyfromcart" },
        ],
      }),
    });

    const touches = await pool.query(
      "SELECT * FROM attribution_touches WHERE tracking_id = $1 AND source = 'tp_checkout_attribution_snippet'",
      [hubTrackingId],
    );
    expect(touches.rowCount).toBe(1);
    expect(touches.rows[0].fbp).toBe("fb.1.222.onlyfromcart");
  });

  it("is idempotent — calling it twice for the same order never creates a duplicate edge", async () => {
    const hubTrackingId = uuid(1);
    const hubSessionId = uuid(2);
    await upsertVisitorAndSession(db, { trackingId: hubTrackingId, sessionId: hubSessionId, shopId: "hub", shopRole: "storefront" });

    const destTrackingId = uuid(3);
    const destSessionId = uuid(4);
    await upsertVisitorAndSession(db, { trackingId: destTrackingId, sessionId: destSessionId, shopId: "alpha-tactical", shopRole: "checkout" });
    await recordCheckoutStart(db, {
      sessionId: destSessionId,
      shopId: "alpha-tactical",
      event: { commerce: { checkout_token: "chk_idempotent" } } as unknown as TrackingEventV1,
    });

    const payload = parseOrderWebhookPayload({
      id: "order_idempotent",
      checkout_token: "chk_idempotent",
      note_attributes: [{ name: "tp_tracking_id", value: hubTrackingId }],
    });

    await linkCrossDomainCheckoutAttribution(db, { checkoutToken: "chk_idempotent", payload });
    await linkCrossDomainCheckoutAttribution(db, { checkoutToken: "chk_idempotent", payload });

    const edges = await pool.query(
      "SELECT * FROM identity_links WHERE entity_a_value = $1 AND entity_b_value = $2",
      [destSessionId, hubSessionId],
    );
    expect(edges.rowCount).toBe(1);
  });
});
