import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { createDatabase, type Database } from "@tracking/db";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";

/**
 * Dedicated coverage for the Redis half of `/ready` (Phase 16 fix — see
 * `routes/health.ts`'s comment: this was a documented gap since Phase 11,
 * closed now that a real orchestrator depends on `/ready` being honest).
 * `server.test.ts`'s own `/health`/`/ready` tests never configure
 * `REDIS_URL`, so `app.metaQueue` is `undefined` there and that check is
 * never exercised — this file builds its own server specifically with
 * `REDIS_URL` set, using the same real-Redis-in-tests pattern already
 * established in `lib/metaQueue.test.ts`.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://tracking:tracking_dev_pw@localhost:5432/tracking_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const HMAC_SECRET = "test-secret-at-least-32-characters-long!!";

let db: Database;
let pool: ReturnType<typeof createDatabase>["pool"];

beforeAll(async () => {
  const created = createDatabase(TEST_DATABASE_URL);
  db = created.db;
  pool = created.pool;
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db, {
    migrationsFolder: new URL("../../../../packages/db/migrations", import.meta.url).pathname,
  });
});

afterAll(async () => {
  await pool.end();
});

describe("GET /ready — Redis check (REDIS_URL configured)", () => {
  it("reports ready when both Postgres and Redis are reachable", async () => {
    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      GATEWAY_HMAC_SECRET: HMAC_SECRET,
      REDIS_URL: TEST_REDIS_URL,
    } as unknown as NodeJS.ProcessEnv);
    const app: FastifyInstance = await buildServer({ db, config });

    try {
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ready" });
    } finally {
      await app.close();
    }
  });

  it("reports not_ready with redis_unreachable when REDIS_URL points at an unreachable host", async () => {
    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      GATEWAY_HMAC_SECRET: HMAC_SECRET,
      // Port 1 is never a real Redis in this test environment — ioredis
      // will fail to connect, which is exactly the failure mode this test
      // proves fails closed rather than silently reporting ready.
      REDIS_URL: "redis://127.0.0.1:1",
    } as unknown as NodeJS.ProcessEnv);
    const app: FastifyInstance = await buildServer({ db, config });

    try {
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: "not_ready", reason: "redis_unreachable" });
    } finally {
      await app.close();
    }
    // Bounded by READINESS_REDIS_TIMEOUT_MS (health.ts) at 2s — this test
    // timeout only needs margin above that, not the old unbounded hang.
  }, 10_000);
});
