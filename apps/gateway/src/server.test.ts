import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { createDatabase, type Database } from "@tracking/db";
import { createHmac } from "node:crypto";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { signHmac } from "./lib/crypto.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://tracking:tracking_dev_pw@localhost:5432/tracking_test";

const HMAC_SECRET = "test-secret-at-least-32-characters-long!!";
const APP_PROXY_SECRET = "app-proxy-shared-secret-test-only";

let db: Database;
let pool: ReturnType<typeof createDatabase>["pool"];
let app: FastifyInstance;

function signedPost(path: string, body: unknown) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/json",
      "x-gateway-signature": signHmac(HMAC_SECRET, raw),
    },
    payload: raw,
  });
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Signs query params the way Shopify's App Proxy edge would, for tests. */
function appProxySign(params: Record<string, string>): string {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("");
  return createHmac("sha256", APP_PROXY_SECRET).update(canonical).digest("hex");
}

function appProxyPost(path: string, params: Record<string, string>, body: unknown) {
  const signature = appProxySign(params);
  const qs = new URLSearchParams({ ...params, signature }).toString();
  return app.inject({
    method: "POST",
    url: `${path}?${qs}`,
    payload: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  const created = createDatabase(TEST_DATABASE_URL);
  db = created.db;
  pool = created.pool;

  await pool.query(
    "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
  );
  await migrate(db, {
    migrationsFolder: new URL("../../../packages/db/migrations", import.meta.url).pathname,
  });

  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    GATEWAY_HMAC_SECRET: HMAC_SECRET,
    CORS_ALLOWLIST: "https://store-a.example.com,https://store-b.example.com",
    // Registers the Hub plus TWO distinct destination/checkout stores (not
    // just one) so this suite can prove the multi-destination-store fix
    // actually works end-to-end — see the "redirects two different
    // products' transfers to two different destination store domains" test
    // below, and docs/PHASE_LOG.md's "Correção de Arquitetura — Multi-Loja
    // de Destino".
    SHOPIFY_STORES: JSON.stringify([
      { shop_id: "store-a", domain: "store-a.example.com", role: "storefront", webhook_secret: "store-a-webhook-secret-test-only" },
      { shop_id: "store-b", domain: "store-b.example.com", role: "checkout", webhook_secret: "store-b-webhook-secret-test-only" },
      { shop_id: "store-c", domain: "store-c.example.com", role: "checkout", webhook_secret: "store-c-webhook-secret-test-only" },
    ]),
    SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET,
    TRANSFER_TOKEN_TTL_SECONDS: "2",
  } as unknown as NodeJS.ProcessEnv);

  app = await buildServer({ db, config });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE identity_links, transfers, attribution_touches, checkouts, event_registry, events, sessions, visitors RESTART IDENTITY CASCADE",
  );
});

describe("GET /health and /ready", () => {
  it("reports liveness without touching the database", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("reports readiness by checking the database", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });
});

describe("POST /v1/events", () => {
  it("accepts a valid browser event and persists visitor/session/event", async () => {
    const trackingId = uuid(1);
    const sessionId = uuid(2);

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        schema_version: "1.0",
        event_id: "evt_page_1",
        event_name: "page_viewed",
        event_time: new Date().toISOString(),
        shop: { shop_id: "store-a", role: "storefront" },
        identity: { tracking_id: trackingId, session_id: sessionId },
        attribution: { fbclid: "abc", utm_source: "meta" },
        source: { origin: "browser" },
        metadata: { environment: "development" },
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toEqual(["evt_page_1"]);
    expect(body.rejected).toEqual([]);
  });

  it("is idempotent: re-sending the same event_id reports it as a duplicate, not an error", async () => {
    const payload = {
      schema_version: "1.0",
      event_id: "evt_dup_1",
      event_name: "product_viewed",
      event_time: new Date().toISOString(),
      shop: { shop_id: "store-a", role: "storefront" },
      identity: { tracking_id: uuid(3), session_id: uuid(4) },
      source: { origin: "browser" },
      metadata: { environment: "development" },
    };

    const first = await app.inject({ method: "POST", url: "/v1/events", payload });
    const second = await app.inject({ method: "POST", url: "/v1/events", payload });

    expect(first.json().accepted).toEqual(["evt_dup_1"]);
    expect(second.json().duplicates).toEqual(["evt_dup_1"]);
    expect(second.json().accepted).toEqual([]);
  });

  it("rejects order_paid originating from the browser (webhook-first purchase rule)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        schema_version: "1.0",
        event_id: "evt_bad_purchase",
        event_name: "order_paid",
        event_time: new Date().toISOString(),
        shop: { shop_id: "store-b", role: "checkout" },
        identity: { tracking_id: uuid(5), session_id: uuid(6) },
        source: { origin: "browser" },
        metadata: { environment: "development" },
      },
    });

    expect(res.statusCode).toBe(202); // batch-style response, per-item rejection
    expect(res.json().rejected).toHaveLength(1);
    expect(res.json().accepted).toEqual([]);
  });

  it("supports a batch of events in one request", async () => {
    const base = {
      schema_version: "1.0" as const,
      event_time: new Date().toISOString(),
      shop: { shop_id: "store-a", role: "storefront" as const },
      identity: { tracking_id: uuid(7), session_id: uuid(8) },
      source: { origin: "browser" as const },
      metadata: { environment: "development" as const },
    };

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        events: [
          { ...base, event_id: "evt_batch_1", event_name: "page_viewed" },
          { ...base, event_id: "evt_batch_2", event_name: "product_viewed" },
        ],
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().accepted.sort()).toEqual(["evt_batch_1", "evt_batch_2"]);
  });
});

describe("Cross-domain transfer bridge", () => {
  it("rejects transfer/create without a valid HMAC signature", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/transfer/create",
      payload: { tracking_id: uuid(10), session_id: uuid(11) },
    });
    expect(res.statusCode).toBe(401);
  });

  it("full happy path: create -> redirect -> redeem links session A to session B", async () => {
    const trackingIdA = uuid(20);
    const sessionIdA = uuid(21);
    const sessionIdB = uuid(22);

    // A session must exist before we can attribute a transfer to it —
    // simulate the page_viewed event Store A's pixel would have sent.
    await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        schema_version: "1.0",
        event_id: "evt_landing_a",
        event_name: "page_viewed",
        event_time: new Date().toISOString(),
        shop: { shop_id: "store-a", role: "storefront" },
        identity: { tracking_id: trackingIdA, session_id: sessionIdA },
        source: { origin: "browser" },
        metadata: { environment: "development" },
      },
    });

    const createRes = await signedPost("/v1/transfer/create", {
      tracking_id: trackingIdA,
      session_id: sessionIdA,
      destination_shop_id: "store-b",
      cart: [{ variant_id: "111", quantity: 2 }],
    });
    expect(createRes.statusCode).toBe(201);
    const { token, redirect_path: redirectPath } = createRes.json();
    expect(typeof token).toBe("string");

    const redirectRes = await app.inject({ method: "GET", url: redirectPath });
    expect(redirectRes.statusCode).toBe(302);
    expect(redirectRes.headers.location).toContain("store-b.example.com/cart/111:2");
    expect(redirectRes.headers.location).toContain(`attributes%5Bttid%5D=${token}`);

    const redeemRes = await signedPost("/v1/transfer/redeem", {
      token,
      session_id: sessionIdB,
    });
    expect(redeemRes.statusCode).toBe(200);
    expect(redeemRes.json()).toEqual({
      status: "redeemed",
      tracking_id: trackingIdA,
      source_session_id: sessionIdA,
    });

    // A second redemption attempt of the same (now-consumed) token must be
    // rejected as a replay, never silently accepted.
    const replayRes = await signedPost("/v1/transfer/redeem", {
      token,
      session_id: uuid(23),
    });
    expect(replayRes.statusCode).toBe(409);
    expect(replayRes.json()).toEqual({ status: "replay_detected" });
  });

  it("rejects redemption of an unknown token", async () => {
    const res = await signedPost("/v1/transfer/redeem", {
      token: "does-not-exist",
      session_id: uuid(30),
    });
    expect(res.statusCode).toBe(404);
  });

  it("routes two different products' transfers to two different destination store domains (multi-loja de destino)", async () => {
    // This is the direct, concrete proof of the fix: the SAME Hub, in the
    // SAME test run, sends one click to store-b.example.com and a
    // different click to store-c.example.com — never a single
    // Gateway-wide destination domain. See docs/PHASE_LOG.md's "Correção
    // de Arquitetura — Multi-Loja de Destino".
    const trackingId = uuid(70);
    const sessionToB = uuid(71);
    const sessionToC = uuid(72);

    for (const sessionId of [sessionToB, sessionToC]) {
      await app.inject({
        method: "POST",
        url: "/v1/events",
        payload: {
          schema_version: "1.0",
          event_id: `evt_landing_${sessionId}`,
          event_name: "page_viewed",
          event_time: new Date().toISOString(),
          shop: { shop_id: "store-a", role: "storefront" },
          identity: { tracking_id: trackingId, session_id: sessionId },
          source: { origin: "browser" },
          metadata: { environment: "development" },
        },
      });
    }

    const createForB = await signedPost("/v1/transfer/create", {
      tracking_id: trackingId,
      session_id: sessionToB,
      destination_shop_id: "store-b",
      cart: [{ variant_id: "222", quantity: 1 }],
    });
    const createForC = await signedPost("/v1/transfer/create", {
      tracking_id: trackingId,
      session_id: sessionToC,
      destination_shop_id: "store-c",
      cart: [{ variant_id: "333", quantity: 1 }],
    });
    expect(createForB.statusCode).toBe(201);
    expect(createForC.statusCode).toBe(201);

    const redirectToB = await app.inject({
      method: "GET",
      url: createForB.json().redirect_path,
    });
    const redirectToC = await app.inject({
      method: "GET",
      url: createForC.json().redirect_path,
    });

    expect(redirectToB.statusCode).toBe(302);
    expect(redirectToB.headers.location).toContain("store-b.example.com/cart/222:1");
    expect(redirectToC.statusCode).toBe(302);
    expect(redirectToC.headers.location).toContain("store-c.example.com/cart/333:1");
  });

  it("fails closed with 500 when a transfer names a destination_shop_id not in SHOPIFY_STORES", async () => {
    const trackingId = uuid(75);
    const sessionId = uuid(76);

    await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        schema_version: "1.0",
        event_id: "evt_landing_unregistered",
        event_name: "page_viewed",
        event_time: new Date().toISOString(),
        shop: { shop_id: "store-a", role: "storefront" },
        identity: { tracking_id: trackingId, session_id: sessionId },
        source: { origin: "browser" },
        metadata: { environment: "development" },
      },
    });

    const createRes = await signedPost("/v1/transfer/create", {
      tracking_id: trackingId,
      session_id: sessionId,
      destination_shop_id: "store-not-registered",
    });
    expect(createRes.statusCode).toBe(201);

    const redirectRes = await app.inject({ method: "GET", url: createRes.json().redirect_path });
    expect(redirectRes.statusCode).toBe(500);
    expect(redirectRes.json()).toEqual({ error: "redirect_target_not_configured" });
  });

  it("rejects redemption of an expired token", async () => {
    const trackingId = uuid(40);
    const sessionId = uuid(41);

    await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        schema_version: "1.0",
        event_id: "evt_landing_expire",
        event_name: "page_viewed",
        event_time: new Date().toISOString(),
        shop: { shop_id: "store-a", role: "storefront" },
        identity: { tracking_id: trackingId, session_id: sessionId },
        source: { origin: "browser" },
        metadata: { environment: "development" },
      },
    });

    const createRes = await signedPost("/v1/transfer/create", {
      tracking_id: trackingId,
      session_id: sessionId,
      destination_shop_id: "store-b",
    });
    const { token } = createRes.json();

    // Config was loaded with a 2 second TTL for this test suite.
    await new Promise((resolve) => setTimeout(resolve, 2100));

    const redeemRes = await signedPost("/v1/transfer/redeem", {
      token,
      session_id: uuid(42),
    });
    expect(redeemRes.statusCode).toBe(410);
  });
});

describe("App Proxy authenticated routes (/proxy/*) — browser-facing", () => {
  it("rejects a request with no signature at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/proxy/transfer/create?shop=store-a.example.com",
      payload: JSON.stringify({ tracking_id: uuid(50), session_id: uuid(51) }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a request signed with the wrong secret", async () => {
    const badSignature = createHmac("sha256", "not-the-real-secret")
      .update("shop=store-a.example.com")
      .digest("hex");
    const res = await app.inject({
      method: "POST",
      url: `/proxy/transfer/create?shop=store-a.example.com&signature=${badSignature}`,
      payload: JSON.stringify({ tracking_id: uuid(52), session_id: uuid(53) }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("full happy path through the app-proxy-authenticated create/redeem, exactly as the storefront would call it", async () => {
    const trackingId = uuid(60);
    const sessionIdA = uuid(61);
    const sessionIdB = uuid(62);

    await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        schema_version: "1.0",
        event_id: "evt_proxy_landing",
        event_name: "page_viewed",
        event_time: new Date().toISOString(),
        shop: { shop_id: "store-a", role: "storefront" },
        identity: { tracking_id: trackingId, session_id: sessionIdA },
        source: { origin: "browser" },
        metadata: { environment: "development" },
      },
    });

    const createRes = await appProxyPost(
      "/proxy/transfer/create",
      { shop: "store-a.example.com", timestamp: "1317327555" },
      { tracking_id: trackingId, session_id: sessionIdA, destination_shop_id: "store-b" },
    );
    expect(createRes.statusCode).toBe(201);
    const { token } = createRes.json();

    const redeemRes = await appProxyPost(
      "/proxy/transfer/redeem",
      { shop: "store-b.example.com", timestamp: "1317327600" },
      { token, session_id: sessionIdB },
    );
    expect(redeemRes.statusCode).toBe(200);
    expect(redeemRes.json().tracking_id).toBe(trackingId);
  });

  // Regression test for the real production bug found in the readiness
  // review after Store C shipped: this project installs THREE separate
  // Shopify apps (Store A/B/C), each with its own client secret — an App
  // Proxy call from Store B's storefront is signed with STORE B's app
  // secret, never the single legacy SHOPIFY_APP_PROXY_SECRET. Before the
  // fix, `/proxy/*` only ever accepted the one shared secret, so two of
  // the three real stores could never successfully call transfer
  // create/redeem through their App Proxy at all.
  it("accepts a request signed with a PER-APP client secret (Store B's), distinct from the shared SHOPIFY_APP_PROXY_SECRET", async () => {
    const multiAppConfig = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      GATEWAY_HMAC_SECRET: HMAC_SECRET,
      CORS_ALLOWLIST: "https://store-a.example.com",
      SHOPIFY_STORES: JSON.stringify([
        { shop_id: "store-a", domain: "store-a.example.com", role: "storefront", webhook_secret: "store-a-webhook-secret-test-only" },
        { shop_id: "store-b", domain: "store-b.example.com", role: "checkout", webhook_secret: "store-b-webhook-secret-test-only" },
      ]),
      // Deliberately NOT the same as the shared legacy secret used by the
      // rest of this suite's `app` instance.
      PIXEL_APP_STORE_A_CLIENT_ID: "app-a-client-id",
      PIXEL_APP_STORE_A_CLIENT_SECRET: "app-a-client-secret-test-only",
      PIXEL_APP_STORE_B_CLIENT_ID: "app-b-client-id",
      PIXEL_APP_STORE_B_CLIENT_SECRET: "app-b-client-secret-test-only",
      TRANSFER_TOKEN_TTL_SECONDS: "600",
    } as unknown as NodeJS.ProcessEnv);
    const multiAppServer = await buildServer({ db, config: multiAppConfig });

    try {
      // The visitor must exist before /proxy/transfer/create can insert a
      // transfer row referencing it (transfers.source_tracking_id FK) —
      // same prerequisite the "full happy path" test above satisfies via a
      // prior /v1/events call.
      await multiAppServer.inject({
        method: "POST",
        url: "/v1/events",
        payload: {
          schema_version: "1.0",
          event_id: "evt_multi_app_landing",
          event_name: "page_viewed",
          event_time: new Date().toISOString(),
          shop: { shop_id: "store-a", role: "storefront" },
          identity: { tracking_id: uuid(70), session_id: uuid(71) },
          source: { origin: "browser" },
          metadata: { environment: "development" },
        },
      });

      const canonical = "shop=store-b.example.com";
      const signature = createHmac("sha256", "app-b-client-secret-test-only").update(canonical).digest("hex");

      const res = await multiAppServer.inject({
        method: "POST",
        url: `/proxy/transfer/create?shop=store-b.example.com&signature=${signature}`,
        payload: JSON.stringify({ tracking_id: uuid(70), session_id: uuid(71), destination_shop_id: "store-a" }),
        headers: { "content-type": "application/json" },
      });

      expect(res.statusCode).toBe(201);
    } finally {
      await multiAppServer.close();
    }
  });
});

describe("Identity Graph inputs recorded during /v1/events ingestion (Phase 8)", () => {
  it("records exactly one attribution touch for a session's first event, not its second", async () => {
    const trackingId = uuid(5);
    const sessionId = uuid(6);

    const first = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        schema_version: "1.0",
        event_id: "evt_touch_1",
        event_name: "page_viewed",
        event_time: new Date().toISOString(),
        shop: { shop_id: "store-a", role: "storefront" },
        identity: { tracking_id: trackingId, session_id: sessionId },
        attribution: { fbclid: "fbclid_1", utm_campaign: "spring_sale" },
        source: { origin: "browser" },
        metadata: { environment: "development" },
      },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        schema_version: "1.0",
        event_id: "evt_touch_2",
        event_name: "product_viewed",
        event_time: new Date().toISOString(),
        shop: { shop_id: "store-a", role: "storefront" },
        identity: { tracking_id: trackingId, session_id: sessionId },
        source: { origin: "browser" },
        metadata: { environment: "development" },
      },
    });
    expect(second.statusCode).toBe(202);

    const touches = await pool.query(
      "SELECT * FROM attribution_touches WHERE tracking_id = $1",
      [trackingId],
    );
    expect(touches.rowCount).toBe(1);
    expect(touches.rows[0].is_paid).toBe(true);
    expect(touches.rows[0].campaign).toBe("spring_sale");

    const fbcLinks = await pool.query(
      "SELECT * FROM identity_links WHERE entity_a_type = 'fbclid'",
    );
    // fbclid itself isn't a graph edge type (only fbc/fbp are, per
    // docs/ARCHITECTURE.md section E) — confirms this test isn't
    // accidentally passing by matching the wrong column.
    expect(fbcLinks.rowCount).toBe(0);
  });

  it("records the checkouts row when a checkout_started event carries a checkout_token", async () => {
    const trackingId = uuid(7);
    const sessionId = uuid(8);

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        schema_version: "1.0",
        event_id: "evt_checkout_started_1",
        event_name: "checkout_started",
        event_time: new Date().toISOString(),
        shop: { shop_id: "store-b", role: "checkout" },
        identity: { tracking_id: trackingId, session_id: sessionId },
        commerce: { checkout_token: "chk_http_test", currency: "BRL" },
        source: { origin: "browser" },
        metadata: { environment: "development" },
      },
    });
    expect(res.statusCode).toBe(202);

    const checkouts = await pool.query(
      "SELECT * FROM checkouts WHERE checkout_token = 'chk_http_test'",
    );
    expect(checkouts.rowCount).toBe(1);
    expect(checkouts.rows[0].session_id).toBe(sessionId);
  });
});
