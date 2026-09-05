import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase, schema, type Database } from "@tracking/db";
import { upsertVisitorAndSession } from "./identity.js";
import { recordAttributionTouch } from "./attribution.js";
import { recordCheckoutStart } from "./checkoutTracking.js";
import { reconstructJourneyByOrderId, reconstructJourneyByTrackingId, findLinksForEntity } from "./journey.js";
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

const baseAttribution: TrackingEventV1["attribution"] = {};

describe("upsertVisitorAndSession — isNewSession detection", () => {
  it("reports isNewSession=true only on the first call for a given session_id", async () => {
    const trackingId = uuid(1);
    const sessionId = uuid(2);

    const first = await upsertVisitorAndSession(db, {
      trackingId,
      sessionId,
      shopId: "store-a",
      shopRole: "storefront",
    });
    expect(first.isNewSession).toBe(true);

    const second = await upsertVisitorAndSession(db, {
      trackingId,
      sessionId,
      shopId: "store-a",
      shopRole: "storefront",
    });
    expect(second.isNewSession).toBe(false);
  });
});

describe("recordAttributionTouch", () => {
  it("records exactly one touch and mirrors fbc/fbp into identity_links", async () => {
    const trackingId = uuid(10);
    const sessionId = uuid(11);
    await upsertVisitorAndSession(db, { trackingId, sessionId, shopId: "store-a", shopRole: "storefront" });

    await recordAttributionTouch(db, {
      trackingId,
      sessionId,
      attribution: { fbclid: "fb.click.1", fbc: "fb.1.111.click1", fbp: "fb.1.222", utm_campaign: "spring_sale" },
    });

    const touches = await pool.query("SELECT * FROM attribution_touches WHERE tracking_id = $1", [trackingId]);
    expect(touches.rowCount).toBe(1);
    expect(touches.rows[0].is_paid).toBe(true);
    expect(touches.rows[0].campaign).toBe("spring_sale");

    const fbcLinks = await findLinksForEntity(db, "fbc", "fb.1.111.click1");
    expect(fbcLinks).toHaveLength(1);
    expect(fbcLinks[0]?.entityBValue).toBe(sessionId);
    expect(fbcLinks[0]?.confidence).toBe("DETERMINISTIC");

    const fbpLinks = await findLinksForEntity(db, "fbp", "fb.1.222");
    expect(fbpLinks).toHaveLength(1);
  });

  it("persists gclid on the touch row and classifies it as paid Google — no Google Ads campaign live yet, captured anyway (see schema.ts's gclid comment)", async () => {
    const trackingId = uuid(14);
    const sessionId = uuid(15);
    await upsertVisitorAndSession(db, { trackingId, sessionId, shopId: "store-a", shopRole: "storefront" });

    await recordAttributionTouch(db, {
      trackingId,
      sessionId,
      attribution: { gclid: "xyz789", utm_campaign: "search_brand" },
    });

    const touches = await pool.query("SELECT * FROM attribution_touches WHERE tracking_id = $1", [trackingId]);
    expect(touches.rowCount).toBe(1);
    expect(touches.rows[0].gclid).toBe("xyz789");
    expect(touches.rows[0].is_paid).toBe(true);
    expect(touches.rows[0].source).toBe("google");
    // Unlike fbc/fbp, gclid has no identity_links mirroring — it's a click
    // id used directly by Google Ads' own conversion import, not a cookie
    // value we'd ever need to look up a session by.
  });

  it("classifies a touch with no attribution signal as direct, not paid", async () => {
    const trackingId = uuid(12);
    const sessionId = uuid(13);
    await upsertVisitorAndSession(db, { trackingId, sessionId, shopId: "store-a", shopRole: "storefront" });

    await recordAttributionTouch(db, { trackingId, sessionId, attribution: baseAttribution });

    const touches = await pool.query("SELECT * FROM attribution_touches WHERE tracking_id = $1", [trackingId]);
    expect(touches.rows[0].source).toBe("direct");
    expect(touches.rows[0].is_paid).toBe(false);
  });
});

describe("recordCheckoutStart", () => {
  it("does nothing when the event carries no checkout_token", async () => {
    const sessionId = uuid(20);
    const event = { commerce: {} } as unknown as TrackingEventV1;
    await recordCheckoutStart(db, { sessionId, shopId: "store-b", event });

    const rows = await pool.query("SELECT * FROM checkouts");
    expect(rows.rowCount).toBe(0);
  });

  it("upserts the checkouts row idempotently for the same checkout_token", async () => {
    const trackingId = uuid(22);
    const sessionId = uuid(21);
    // In real ingestion, upsertVisitorAndSession always runs (for the same
    // event) before recordCheckoutStart — see routes/events.ts — so the
    // session row this FK depends on already exists by the time this is
    // called; recreate that ordering here rather than skip it.
    await upsertVisitorAndSession(db, { trackingId, sessionId, shopId: "store-b", shopRole: "checkout" });

    const event = {
      commerce: { checkout_token: "chk_xyz", currency: "BRL" },
    } as unknown as TrackingEventV1;

    await recordCheckoutStart(db, { sessionId, shopId: "store-b", event });
    await recordCheckoutStart(db, { sessionId, shopId: "store-b", event });

    const rows = await pool.query("SELECT * FROM checkouts WHERE checkout_token = 'chk_xyz'");
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].session_id).toBe(sessionId);
  });
});

describe("reconstructJourneyByTrackingId", () => {
  it("returns only this tracking_id's own touches when there is no cross-domain link", async () => {
    const trackingId = uuid(30);
    const sessionId = uuid(31);
    await upsertVisitorAndSession(db, { trackingId, sessionId, shopId: "store-a", shopRole: "storefront" });
    await recordAttributionTouch(db, { trackingId, sessionId, attribution: { fbclid: "f1" } });

    const journey = await reconstructJourneyByTrackingId(db, trackingId);
    expect(journey.trackingIds).toEqual([trackingId]);
    expect(journey.linkedIdentities).toEqual([]);
    expect(journey.touches).toHaveLength(1);
  });

  it("merges touches across a DETERMINISTIC session_id<->session_id cross-domain edge", async () => {
    const trackingIdA = uuid(40);
    const sessionIdA = uuid(41);
    const trackingIdB = uuid(42);
    const sessionIdB = uuid(43);

    await upsertVisitorAndSession(db, {
      trackingId: trackingIdA,
      sessionId: sessionIdA,
      shopId: "store-a",
      shopRole: "storefront",
    });
    await recordAttributionTouch(db, {
      trackingId: trackingIdA,
      sessionId: sessionIdA,
      attribution: { fbclid: "f1", utm_campaign: "day1_meta" },
    });

    await upsertVisitorAndSession(db, {
      trackingId: trackingIdB,
      sessionId: sessionIdB,
      shopId: "store-b",
      shopRole: "checkout",
    });
    await recordAttributionTouch(db, {
      trackingId: trackingIdB,
      sessionId: sessionIdB,
      attribution: {},
    });

    await db.insert(schema.identityLinks).values({
      entityAType: "session_id",
      entityAValue: sessionIdA,
      entityBType: "session_id",
      entityBValue: sessionIdB,
      confidence: "DETERMINISTIC",
      source: "cross_domain_transfer",
    });

    const journey = await reconstructJourneyByTrackingId(db, trackingIdB);
    expect(new Set(journey.trackingIds)).toEqual(new Set([trackingIdA, trackingIdB]));
    expect(journey.linkedIdentities).toHaveLength(1);
    expect(journey.linkedIdentities[0]?.trackingId).toBe(trackingIdA);
    expect(journey.linkedIdentities[0]?.confidence).toBe("DETERMINISTIC");
    expect(journey.touches).toHaveLength(2);
    // Chronological, and both sides represented.
    expect(journey.touches.map((t) => t.trackingId).sort()).toEqual([trackingIdA, trackingIdB].sort());
  });
});

describe("reconstructJourneyByOrderId", () => {
  it("returns order_not_found for an unknown order", async () => {
    const result = await reconstructJourneyByOrderId(db, "does-not-exist");
    expect(result.status).toBe("order_not_found");
  });

  it("returns no_checkout_correlation when the order has no checkout_token", async () => {
    await db.insert(schema.orders).values({ orderId: "o1", shopId: "store-b" });
    const result = await reconstructJourneyByOrderId(db, "o1");
    expect(result.status).toBe("no_checkout_correlation");
  });

  it("returns checkout_not_tracked when the token was never observed by the pixel", async () => {
    await db.insert(schema.orders).values({ orderId: "o2", shopId: "store-b", checkoutToken: "chk_missing" });
    const result = await reconstructJourneyByOrderId(db, "o2");
    expect(result.status).toBe("checkout_not_tracked");
  });

  it("reconstructs the full cross-domain journey end to end from an order_id", async () => {
    const trackingIdA = uuid(50);
    const sessionIdA = uuid(51);
    const trackingIdB = uuid(52);
    const sessionIdB = uuid(53);

    await upsertVisitorAndSession(db, {
      trackingId: trackingIdA,
      sessionId: sessionIdA,
      shopId: "store-a",
      shopRole: "storefront",
    });
    await recordAttributionTouch(db, {
      trackingId: trackingIdA,
      sessionId: sessionIdA,
      attribution: { fbclid: "f1", utm_campaign: "day1_meta" },
    });

    await upsertVisitorAndSession(db, {
      trackingId: trackingIdB,
      sessionId: sessionIdB,
      shopId: "store-b",
      shopRole: "checkout",
    });

    await db.insert(schema.identityLinks).values({
      entityAType: "session_id",
      entityAValue: sessionIdA,
      entityBType: "session_id",
      entityBValue: sessionIdB,
      confidence: "DETERMINISTIC",
      source: "cross_domain_transfer",
    });

    await recordCheckoutStart(db, {
      sessionId: sessionIdB,
      shopId: "store-b",
      event: { commerce: { checkout_token: "chk_ok" } } as unknown as TrackingEventV1,
    });

    await db.insert(schema.orders).values({ orderId: "o3", shopId: "store-b", checkoutToken: "chk_ok" });

    const result = await reconstructJourneyByOrderId(db, "o3");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.trackingId).toBe(trackingIdB);
    expect(new Set(result.journey.trackingIds)).toEqual(new Set([trackingIdA, trackingIdB]));
    expect(result.journey.touches).toHaveLength(1);
    expect(result.journey.touches[0]?.campaign).toBe("day1_meta");
  });
});
