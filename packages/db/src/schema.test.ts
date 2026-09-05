import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDatabase, type Database } from "./client.js";
import * as schema from "./schema.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://tracking:tracking_dev_pw@localhost:5432/tracking_test";

let db: Database;
let pool: ReturnType<typeof createDatabase>["pool"];

beforeAll(async () => {
  const created = createDatabase(TEST_DATABASE_URL);
  db = created.db;
  pool = created.pool;

  // Reset schema so this suite is idempotent across runs. The `drizzle`
  // schema (migration history) must be dropped too, otherwise drizzle
  // thinks migrations already ran and silently skips recreating tables.
  await pool.query(
    "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
  );
  await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
});

afterAll(async () => {
  await pool.end();
});

describe("schema — identity chain (visitor -> session -> touch)", () => {
  it("persists a visitor, a session referencing it, and an attribution touch", async () => {
    const [visitor] = await db.insert(schema.visitors).values({}).returning();
    expect(visitor?.trackingId).toBeTruthy();

    const [session] = await db
      .insert(schema.sessions)
      .values({
        trackingId: visitor!.trackingId,
        shopId: "store-a",
        shopRole: "storefront",
        landingPage: "https://store-a.example.com/products/x",
      })
      .returning();
    expect(session?.shopRole).toBe("storefront");

    const [touch] = await db
      .insert(schema.attributionTouches)
      .values({
        trackingId: visitor!.trackingId,
        sessionId: session!.sessionId,
        source: "meta",
        medium: "cpc",
        campaign: "summer_sale",
        fbclid: "abc123",
        isPaid: true,
      })
      .returning();
    expect(touch?.isPaid).toBe(true);

    const touches = await db
      .select()
      .from(schema.attributionTouches)
      .where(eq(schema.attributionTouches.trackingId, visitor!.trackingId));
    expect(touches).toHaveLength(1);
  });

  it("rejects a session referencing a non-existent visitor (FK enforced)", async () => {
    await expect(
      db.insert(schema.sessions).values({
        trackingId: "00000000-0000-4000-8000-000000000000",
        shopId: "store-a",
        shopRole: "storefront",
      }),
    ).rejects.toThrow();
  });
});

describe("schema — cross-domain transfer", () => {
  it("enforces single-use via unique token_hash", async () => {
    const [visitor] = await db.insert(schema.visitors).values({}).returning();
    const [session] = await db
      .insert(schema.sessions)
      .values({ trackingId: visitor!.trackingId, shopId: "store-a", shopRole: "storefront" })
      .returning();

    const tokenHash = "hash_of_opaque_token";
    await db.insert(schema.transfers).values({
      tokenHash,
      sourceTrackingId: visitor!.trackingId,
      sourceSessionId: session!.sessionId,
      destinationShopId: "store-b",
      nonce: "nonce-1",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    await expect(
      db.insert(schema.transfers).values({
        tokenHash, // duplicate — must be rejected
        sourceTrackingId: visitor!.trackingId,
        sourceSessionId: session!.sessionId,
        destinationShopId: "store-b",
        nonce: "nonce-2",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      }),
    ).rejects.toThrow();
  });
});

describe("schema — event dedup ledger", () => {
  it("prevents two rows with the same event_id (idempotency key)", async () => {
    await db.insert(schema.eventRegistry).values({
      eventId: "purchase:store-b:1001",
      eventName: "order_paid",
      sourceOrigin: "webhook",
    });

    await expect(
      db.insert(schema.eventRegistry).values({
        eventId: "purchase:store-b:1001",
        eventName: "order_paid",
        sourceOrigin: "webhook",
      }),
    ).rejects.toThrow();
  });
});

describe("schema — webhook idempotency", () => {
  it("enforces uniqueness on (shop_id, webhook_id)", async () => {
    await db.insert(schema.webhookReceipts).values({
      shopId: "store-b",
      topic: "orders/paid",
      webhookId: "wh_1",
      hmacValid: true,
    });

    await expect(
      db.insert(schema.webhookReceipts).values({
        shopId: "store-b",
        topic: "orders/paid",
        webhookId: "wh_1", // same shop + same webhook id => duplicate delivery
        hmacValid: true,
      }),
    ).rejects.toThrow();
  });
});

describe("schema — identity graph edges", () => {
  it("stores a DETERMINISTIC edge and rejects an exact duplicate edge", async () => {
    await db.insert(schema.identityLinks).values({
      entityAType: "session_id",
      entityAValue: "11111111-1111-4111-8111-111111111111",
      entityBType: "session_id",
      entityBValue: "22222222-2222-4222-8222-222222222222",
      confidence: "DETERMINISTIC",
      source: "cross_domain_transfer",
    });

    await expect(
      db.insert(schema.identityLinks).values({
        entityAType: "session_id",
        entityAValue: "11111111-1111-4111-8111-111111111111",
        entityBType: "session_id",
        entityBValue: "22222222-2222-4222-8222-222222222222",
        confidence: "DETERMINISTIC",
        source: "cross_domain_transfer",
      }),
    ).rejects.toThrow();
  });
});
