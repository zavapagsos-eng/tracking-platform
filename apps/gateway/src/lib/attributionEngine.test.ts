import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase, schema, type Database } from "@tracking/db";
import { upsertVisitorAndSession } from "./identity.js";
import { recordAttributionTouch } from "./attribution.js";
import { recordCheckoutStart } from "./checkoutTracking.js";
import { computeOrderAttribution } from "./attributionEngine.js";
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

describe("computeOrderAttribution", () => {
  it("passes through the journey's non-ok status untouched, with no models attached", async () => {
    const result = await computeOrderAttribution(db, "does-not-exist");
    expect(result.status).toBe("order_not_found");
    expect("models" in result).toBe(false);
  });

  it("computes all four models for a fully resolved cross-domain order", async () => {
    const trackingIdA = uuid(60);
    const sessionIdA = uuid(61);
    const trackingIdB = uuid(62);
    const sessionIdB = uuid(63);

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
    await recordAttributionTouch(db, { trackingId: trackingIdB, sessionId: sessionIdB, attribution: {} });

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
      event: { commerce: { checkout_token: "chk_attr" } } as unknown as TrackingEventV1,
    });
    await db.insert(schema.orders).values({ orderId: "o_attr", shopId: "store-b", checkoutToken: "chk_attr" });

    const result = await computeOrderAttribution(db, "o_attr");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");

    // Two touches total: the Meta-attributed one from Store A (earlier)
    // and the direct one recorded on Store B (later, since it was created
    // second in this test).
    expect(result.models.FIRST_TOUCH?.campaign).toBe("day1_meta");
    expect(result.models.LAST_PAID_TOUCH?.campaign).toBe("day1_meta");
    expect(result.models.LAST_NON_DIRECT?.campaign).toBe("day1_meta");
    expect(result.models.LAST_TOUCH?.trackingId).toBe(trackingIdB);
  });
});
