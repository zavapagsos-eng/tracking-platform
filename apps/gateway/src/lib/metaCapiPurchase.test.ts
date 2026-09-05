import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase, schema, type Database } from "@tracking/db";
import { upsertVisitorAndSession } from "./identity.js";
import { recordAttributionTouch } from "./attribution.js";
import { recordCheckoutStart } from "./checkoutTracking.js";
import { recordConsentIfPresent } from "./consent.js";
import { backfillCustomerIdentityFromOrder, parseOrderWebhookPayload } from "./orderIngestion.js";
import { buildPurchaseCapiEvent, purchaseEventId, sendPurchaseToMeta } from "./metaCapiPurchase.js";
import type { TrackingEventV1 } from "@tracking/schema";
import type { MetaCapiCredentials } from "./metaCapiClient.js";

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
    "TRUNCATE identity_links, identity_private, attribution_touches, checkouts, orders, consent_states, event_registry, meta_deliveries, sessions, visitors RESTART IDENTITY CASCADE",
  );
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const credentials: MetaCapiCredentials = {
  datasetId: "1234567890",
  accessToken: "test-access-token",
  apiVersion: "v23.0",
};

/** Seeds a fully-resolved cross-domain order: Store A session with a
 * Meta-attributed touch, linked via a DETERMINISTIC identity edge to a
 * Store B checkout session, a checkouts row, and an order referencing it. */
async function seedFullOrder(orderId: string, checkoutToken: string) {
  const trackingIdA = uuid(100 + orderId.length);
  const sessionIdA = uuid(200 + orderId.length);
  const trackingIdB = uuid(300 + orderId.length);
  const sessionIdB = uuid(400 + orderId.length);

  await upsertVisitorAndSession(db, {
    trackingId: trackingIdA,
    sessionId: sessionIdA,
    shopId: "store-a",
    shopRole: "storefront",
  });
  await recordAttributionTouch(db, {
    trackingId: trackingIdA,
    sessionId: sessionIdA,
    attribution: { fbclid: "f1", fbc: "fb.1.1.click1", fbp: "fb.1.1.p1", utm_campaign: "spring" },
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
    event: { commerce: { checkout_token: checkoutToken } } as unknown as TrackingEventV1,
  });

  await backfillCustomerIdentityFromOrder(db, {
    orderId,
    checkoutToken,
    payload: parseOrderWebhookPayload({
      id: orderId,
      checkout_token: checkoutToken,
      customer: { email: "shopper@example.com", phone: "+15551234567" },
    }),
  });

  await db.insert(schema.orders).values({
    orderId,
    shopId: "store-b",
    checkoutToken,
    currency: "BRL",
    totalAmount: "199.90",
    state: "PAID",
    paidAt: new Date("2026-01-05T12:00:00Z"),
  });

  return { trackingIdA, sessionIdA, trackingIdB, sessionIdB };
}

describe("buildPurchaseCapiEvent", () => {
  it("passes through a non-ok journey status untouched", async () => {
    const result = await buildPurchaseCapiEvent(db, "does-not-exist");
    expect(result.status).toBe("order_not_found");
  });

  it("assembles a full Purchase event with hashed PII, fbc/fbp, client hints, and order value", async () => {
    const { sessionIdB } = await seedFullOrder("o1", "chk_o1");
    // client_ip/user_agent come from the CHECKOUT session (Store B) that
    // the order actually resolves to.
    await pool.query("UPDATE sessions SET ip_address = $1, user_agent = $2, landing_page = $3 WHERE session_id = $4", [
      "203.0.113.9",
      "Mozilla/5.0 (TestAgent)",
      "https://store-b.example.com/checkout",
      sessionIdB,
    ]);

    const result = await buildPurchaseCapiEvent(db, "o1");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");

    expect(result.event.event_id).toBe(purchaseEventId("store-b", "o1"));
    expect(result.event.event_name).toBe("Purchase");
    expect(result.event.action_source).toBe("website");
    expect(result.event.custom_data).toEqual({ currency: "BRL", value: 199.9, order_id: "o1" });
    expect(result.event.user_data.fbc).toBe("fb.1.1.click1");
    expect(result.event.user_data.fbp).toBe("fb.1.1.p1");
    expect(result.event.user_data.em).toBeDefined();
    expect(result.event.user_data.ph).toBeDefined();
    expect(result.event.user_data.client_ip_address).toBe("203.0.113.9");
    expect(result.event.user_data.client_user_agent).toBe("Mozilla/5.0 (TestAgent)");
    expect(result.event.user_data.external_id).toBeDefined();
    expect(result.event.event_source_url).toBe("https://store-b.example.com/checkout");
  });
});

describe("sendPurchaseToMeta — consent gate", () => {
  it("does not send when no consent snapshot exists at all (unknown treated as denied)", async () => {
    await seedFullOrder("o2", "chk_o2");

    const result = await sendPurchaseToMeta(db, "o2", credentials);
    expect(result.status).toBe("consent_not_granted");

    const deliveries = await pool.query("SELECT * FROM meta_deliveries");
    expect(deliveries.rowCount).toBe(0);
  });

  it("does not send when marketing consent was explicitly denied", async () => {
    const { sessionIdB } = await seedFullOrder("o3", "chk_o3");
    await recordConsentIfPresent(db, {
      shopId: "store-b",
      sessionId: sessionIdB,
      consent: { marketingAllowed: false },
    });

    const result = await sendPurchaseToMeta(db, "o3", credentials);
    expect(result.status).toBe("consent_not_granted");
  });
});

describe("sendPurchaseToMeta — send + dedup", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends when consent is granted, marks meta_sent, and records the delivery", async () => {
    const { sessionIdB } = await seedFullOrder("o4", "chk_o4");
    await recordConsentIfPresent(db, {
      shopId: "store-b",
      sessionId: sessionIdB,
      consent: { marketingAllowed: true },
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));

    const result = await sendPurchaseToMeta(db, "o4", credentials);
    expect(result.status).toBe("sent");

    const registry = await pool.query(
      "SELECT meta_sent FROM event_registry WHERE event_id = $1",
      [purchaseEventId("store-b", "o4")],
    );
    expect(registry.rows[0].meta_sent).toBe(true);

    const deliveries = await pool.query(
      "SELECT * FROM meta_deliveries WHERE event_id = $1",
      [purchaseEventId("store-b", "o4")],
    );
    expect(deliveries.rowCount).toBe(1);
    expect(deliveries.rows[0].delivery_status).toBe("delivered");
  });

  it("never calls Meta a second time once already_sent, even with consent granted", async () => {
    const { sessionIdB } = await seedFullOrder("o5", "chk_o5");
    await recordConsentIfPresent(db, {
      shopId: "store-b",
      sessionId: sessionIdB,
      consent: { marketingAllowed: true },
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));

    const first = await sendPurchaseToMeta(db, "o5", credentials);
    expect(first.status).toBe("sent");

    const second = await sendPurchaseToMeta(db, "o5", credentials);
    expect(second.status).toBe("already_sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records a failed delivery on an HTTP error response without marking meta_sent", async () => {
    const { sessionIdB } = await seedFullOrder("o6", "chk_o6");
    await recordConsentIfPresent(db, {
      shopId: "store-b",
      sessionId: sessionIdB,
      consent: { marketingAllowed: true },
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid parameter" } }), { status: 400 }),
    );

    const result = await sendPurchaseToMeta(db, "o6", credentials);
    expect(result.status).toBe("http_error");

    const registry = await pool.query(
      "SELECT meta_sent FROM event_registry WHERE event_id = $1",
      [purchaseEventId("store-b", "o6")],
    );
    expect(registry.rows[0].meta_sent).toBe(false);

    const deliveries = await pool.query(
      "SELECT * FROM meta_deliveries WHERE event_id = $1",
      [purchaseEventId("store-b", "o6")],
    );
    expect(deliveries.rows[0].delivery_status).toBe("failed");
  });
});
