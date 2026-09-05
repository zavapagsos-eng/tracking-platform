import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { hashSync } from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { createDatabase, schema, type Database } from "@tracking/db";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { upsertVisitorAndSession } from "../lib/identity.js";
import { recordAttributionTouch } from "../lib/attribution.js";
import { recordCheckoutStart } from "../lib/checkoutTracking.js";
import { recordDeadLetter } from "../lib/deadLetter.js";
import { purchaseEventId } from "../lib/metaCapiPurchase.js";
import type { TrackingEventV1 } from "@tracking/schema";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://tracking:tracking_dev_pw@localhost:5432/tracking_test";

const HMAC_SECRET = "test-secret-at-least-32-characters-long!!";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "correct-horse-battery-staple";
// Low bcrypt cost (4) so this suite stays fast — never used for a real
// deployment's own hash, only this test fixture's.
const ADMIN_PASSWORD_HASH = hashSync(ADMIN_PASSWORD, 4);

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

let db: Database;
let pool: ReturnType<typeof createDatabase>["pool"];
let app: FastifyInstance;
let appNoAdmin: FastifyInstance;

beforeAll(async () => {
  const created = createDatabase(TEST_DATABASE_URL);
  db = created.db;
  pool = created.pool;

  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db, { migrationsFolder: new URL("../../../../packages/db/migrations", import.meta.url).pathname });

  app = await buildServer({
    db,
    config: loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      GATEWAY_HMAC_SECRET: HMAC_SECRET,
      ADMIN_DASHBOARD_USERNAME: ADMIN_USERNAME,
      ADMIN_DASHBOARD_PASSWORD_HASH: ADMIN_PASSWORD_HASH,
    } as unknown as NodeJS.ProcessEnv),
  });

  appNoAdmin = await buildServer({
    db,
    config: loadConfig({ DATABASE_URL: TEST_DATABASE_URL, GATEWAY_HMAC_SECRET: HMAC_SECRET } as unknown as NodeJS.ProcessEnv),
  });
});

afterAll(async () => {
  await app.close();
  await appNoAdmin.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE identity_links, attribution_touches, checkouts, orders, event_registry, meta_deliveries, dead_letters, reconciliation_runs, sessions, visitors RESTART IDENTITY CASCADE",
  );
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("/admin/* — fails closed when not configured", () => {
  it("returns 501 for any /admin/* route when ADMIN_DASHBOARD_* isn't set", async () => {
    const res = await appNoAdmin.inject({ method: "GET", url: "/admin/dead-letters" });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: "admin_dashboard_not_configured" });
  });
});

describe("/admin/* — HTTP Basic Auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/dead-letters" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Basic");
  });

  it("rejects the wrong password", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/dead-letters",
      headers: { authorization: basicAuthHeader(ADMIN_USERNAME, "not-the-password") },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects the wrong username", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/dead-letters",
      headers: { authorization: basicAuthHeader("not-admin", ADMIN_PASSWORD) },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts valid credentials", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/dead-letters",
      headers: { authorization: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /admin/journey/:orderId", () => {
  it("returns 404 with the specific reason for an order that doesn't exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/journey/does-not-exist",
      headers: { authorization: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ status: "order_not_found", orderId: "does-not-exist" });
  });

  it("returns the full reconstructed journey for an order whose checkout is fully tracked", async () => {
    const trackingIdA = uuid(1);
    const sessionIdA = uuid(2);
    const sessionIdB = uuid(3);

    await upsertVisitorAndSession(db, { trackingId: trackingIdA, sessionId: sessionIdA, shopId: "store-a", shopRole: "storefront" });
    await recordAttributionTouch(db, { trackingId: trackingIdA, sessionId: sessionIdA, attribution: { fbclid: "f1" } });
    await upsertVisitorAndSession(db, { trackingId: uuid(4), sessionId: sessionIdB, shopId: "store-b", shopRole: "checkout" });
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
      event: { commerce: { checkout_token: "chk_admin_1" } } as unknown as TrackingEventV1,
    });
    await db.insert(schema.orders).values({
      orderId: "o_admin_1",
      shopId: "store-b",
      checkoutToken: "chk_admin_1",
      currency: "BRL",
      totalAmount: "50.00",
      state: "PAID",
      paidAt: new Date(),
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/journey/o_admin_1",
      headers: { authorization: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    // `trackingId` is the order's OWN resolved identity (Store B's session,
    // per `resolveSessionForCheckoutToken`) — `journey.trackingIds` is what
    // carries every tracking_id folded in via the cross-domain identity
    // link, Store A's included.
    expect(body.journey.trackingIds).toContain(trackingIdA);
    expect(body.journey.touches).toHaveLength(1);
  });
});

describe("GET /admin/reconciliation/runs", () => {
  it("lists previously persisted runs, newest first", async () => {
    await db.insert(schema.reconciliationRuns).values({
      startedAt: new Date("2026-01-01T00:00:00Z"),
      finishedAt: new Date("2026-01-01T00:00:01Z"),
      matched: 1,
    });
    await db.insert(schema.reconciliationRuns).values({
      startedAt: new Date("2026-02-01T00:00:00Z"),
      finishedAt: new Date("2026-02-01T00:00:01Z"),
      matched: 2,
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/reconciliation/runs",
      headers: { authorization: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) },
    });
    expect(res.statusCode).toBe(200);
    const { runs } = res.json();
    expect(runs).toHaveLength(2);
    expect(runs[0].matched).toBe(2); // newest first
  });
});

describe("POST /admin/reconciliation/run", () => {
  it("runs a scan on demand and persists a new reconciliation_runs row", async () => {
    await db.insert(schema.orders).values({
      orderId: "o_admin_stale",
      shopId: "store-b",
      currency: "BRL",
      totalAmount: "10.00",
      state: "PAID",
      paidAt: new Date(Date.now() - 20 * 60_000),
    });

    const res = await app.inject({
      method: "POST",
      url: "/admin/reconciliation/run",
      headers: { authorization: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.missingMeta).toBeGreaterThanOrEqual(1);
    expect(body.details.some((d: { orderId: string }) => d.orderId === "o_admin_stale")).toBe(true);

    const rows = await pool.query("SELECT * FROM reconciliation_runs WHERE run_id = $1", [body.summary.runId]);
    expect(rows.rowCount).toBe(1);
  });
});

describe("GET /admin/dead-letters", () => {
  it("lists current dead letters", async () => {
    await recordDeadLetter(db, {
      queueName: "meta-capi-purchase",
      jobId: purchaseEventId("store-b", "o_dl_admin"),
      jobData: { orderId: "o_dl_admin", shopId: "store-b" },
      failureReason: "consent_not_granted",
      attemptsMade: 1,
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/dead-letters",
      headers: { authorization: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) },
    });
    expect(res.statusCode).toBe(200);
    const { deadLetters } = res.json();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].failureReason).toBe("consent_not_granted");
  });
});
