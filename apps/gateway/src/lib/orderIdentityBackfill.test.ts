import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase, type Database } from "@tracking/db";
import { createHash } from "node:crypto";
import { upsertVisitorAndSession } from "./identity.js";
import { recordCheckoutStart } from "./checkoutTracking.js";
import { parseOrderWebhookPayload, backfillCustomerIdentityFromOrder } from "./orderIngestion.js";
import type { TrackingEventV1 } from "@tracking/schema";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://tracking:tracking_dev_pw@localhost:5432/tracking_test";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

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
    "TRUNCATE identity_links, identity_private, checkouts, sessions, visitors RESTART IDENTITY CASCADE",
  );
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("backfillCustomerIdentityFromOrder", () => {
  it("does nothing when the order has no checkout_token", async () => {
    await backfillCustomerIdentityFromOrder(db, {
      orderId: "o1",
      checkoutToken: undefined,
      payload: parseOrderWebhookPayload({ id: "o1", email: "shopper@example.com" }),
    });

    const rows = await pool.query("SELECT * FROM identity_private");
    expect(rows.rowCount).toBe(0);
  });

  it("does nothing when the checkout_token was never tracked by the pixel", async () => {
    await backfillCustomerIdentityFromOrder(db, {
      orderId: "o2",
      checkoutToken: "chk_missing",
      payload: parseOrderWebhookPayload({ id: "o2", checkout_token: "chk_missing", email: "shopper@example.com" }),
    });

    const rows = await pool.query("SELECT * FROM identity_private");
    expect(rows.rowCount).toBe(0);
  });

  it("does nothing when the order carries no customer email/phone at all", async () => {
    const trackingId = uuid(1);
    const sessionId = uuid(2);
    await upsertVisitorAndSession(db, { trackingId, sessionId, shopId: "store-b", shopRole: "checkout" });
    await recordCheckoutStart(db, {
      sessionId,
      shopId: "store-b",
      event: { commerce: { checkout_token: "chk_no_pii" } } as unknown as TrackingEventV1,
    });

    await backfillCustomerIdentityFromOrder(db, {
      orderId: "o3",
      checkoutToken: "chk_no_pii",
      payload: parseOrderWebhookPayload({ id: "o3", checkout_token: "chk_no_pii" }),
    });

    const rows = await pool.query("SELECT * FROM identity_private");
    expect(rows.rowCount).toBe(0);
  });

  it("hashes and persists email/phone into identity_private and writes order_id<->hash edges when the checkout resolves", async () => {
    const trackingId = uuid(3);
    const sessionId = uuid(4);
    await upsertVisitorAndSession(db, { trackingId, sessionId, shopId: "store-b", shopRole: "checkout" });
    await recordCheckoutStart(db, {
      sessionId,
      shopId: "store-b",
      event: { commerce: { checkout_token: "chk_pii" } } as unknown as TrackingEventV1,
    });

    await backfillCustomerIdentityFromOrder(db, {
      orderId: "o4",
      checkoutToken: "chk_pii",
      payload: parseOrderWebhookPayload({
        id: "o4",
        checkout_token: "chk_pii",
        customer: { email: "Shopper@Example.com", phone: "+15551234567" },
      }),
    });

    const identityPrivate = await pool.query(
      "SELECT * FROM identity_private WHERE tracking_id = $1",
      [trackingId],
    );
    expect(identityPrivate.rowCount).toBe(1);
    expect(identityPrivate.rows[0].email_hash).toBe(sha256("shopper@example.com"));
    expect(identityPrivate.rows[0].phone_hash).toBe(sha256("15551234567"));

    const emailEdge = await pool.query(
      "SELECT * FROM identity_links WHERE entity_a_value = 'o4' AND entity_b_type = 'email_hash'",
    );
    expect(emailEdge.rowCount).toBe(1);
    expect(emailEdge.rows[0].entity_b_value).toBe(sha256("shopper@example.com"));
    expect(emailEdge.rows[0].confidence).toBe("DETERMINISTIC");
  });

  it("never clobbers an existing hash with a later delivery that omits that field", async () => {
    const trackingId = uuid(5);
    const sessionId = uuid(6);
    await upsertVisitorAndSession(db, { trackingId, sessionId, shopId: "store-b", shopRole: "checkout" });
    await recordCheckoutStart(db, {
      sessionId,
      shopId: "store-b",
      event: { commerce: { checkout_token: "chk_partial" } } as unknown as TrackingEventV1,
    });

    // orders/create carries full customer info.
    await backfillCustomerIdentityFromOrder(db, {
      orderId: "o5",
      checkoutToken: "chk_partial",
      payload: parseOrderWebhookPayload({
        id: "o5",
        checkout_token: "chk_partial",
        customer: { email: "shopper@example.com", phone: "+15551234567" },
      }),
    });

    // orders/paid redelivery arrives with the Protected Customer Data
    // scope since revoked — Shopify sends nulls. The email hash from the
    // first delivery must survive.
    await backfillCustomerIdentityFromOrder(db, {
      orderId: "o5",
      checkoutToken: "chk_partial",
      payload: parseOrderWebhookPayload({
        id: "o5",
        checkout_token: "chk_partial",
        customer: { email: null, phone: null },
      }),
    });

    const identityPrivate = await pool.query(
      "SELECT * FROM identity_private WHERE tracking_id = $1",
      [trackingId],
    );
    expect(identityPrivate.rowCount).toBe(1);
    expect(identityPrivate.rows[0].email_hash).toBe(sha256("shopper@example.com"));
    expect(identityPrivate.rows[0].phone_hash).toBe(sha256("15551234567"));
  });
});
