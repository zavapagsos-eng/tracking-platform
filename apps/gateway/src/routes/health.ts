import type { FastifyInstance } from "fastify";
import { pingDatabase } from "../lib/identity.js";

/** Bounds how long `/ready` will wait on the Redis round-trip below.
 * Verified experimentally (Phase 16) against this project's own
 * `buildRedisConnectionOptions()` (lib/metaQueue.ts), which sets
 * `maxRetriesPerRequest: null` on the Queue connection too — ioredis's
 * documented behavior for that setting is to keep retrying a command
 * indefinitely rather than reject it, and its default `retryStrategy`
 * also keeps retrying the underlying TCP connection forever. Together
 * that means `queue.getVersion()` against an unreachable Redis does not
 * reject on its own — confirmed by running it against a closed port,
 * where it hung past 5s with no rejection until raced against a timer.
 * Without this timeout, a down Redis would make `/ready` hang instead of
 * failing closed — worse than not checking Redis at all, since it could
 * stall an orchestrator's readiness probes. */
const READINESS_REDIS_TIMEOUT_MS = 2000;

/** /health = liveness (process is up, no dependency checks).
 * /ready = readiness (dependencies the Gateway needs to actually work are
 * reachable) — spec section 46. Redis readiness (this function's second
 * check) was left as a documented follow-up when the queue was introduced
 * in Phase 11 (`REDIS_URL` is optional — see `createMetaCapiQueue()` —
 * so there was nothing to ping yet at boot in every configuration); closed
 * here in Phase 16 now that shipping this to production makes the
 * orchestrator's use of `/ready` to gate traffic/restarts load-bearing. */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.get("/ready", async (_request, reply) => {
    try {
      const dbOk = await pingDatabase(app.db);
      if (!dbOk) {
        return reply.code(503).send({ status: "not_ready", reason: "database_unreachable" });
      }
    } catch (err) {
      app.log.error({ err }, "readiness check failed (database)");
      return reply.code(503).send({ status: "not_ready", reason: "database_unreachable" });
    }

    // `app.metaQueue` is only defined when REDIS_URL is configured
    // (createMetaCapiQueue's fail-closed pattern, Phase 11) — when it
    // isn't, there's no Redis dependency to be ready for, so readiness
    // rests on the database check above alone, same as before this fix.
    if (app.metaQueue) {
      const queue = app.metaQueue;
      try {
        // `getVersion()` is a documented public Queue method (bullmq v6
        // `classes/queue.d.ts`) that reads a value back from Redis, so a
        // successful resolution proves the connection is actually live —
        // not just constructed. It doesn't matter whether the returned
        // version string is present; only whether the round-trip succeeds
        // within budget — see READINESS_REDIS_TIMEOUT_MS above for why a
        // timeout guard is required here, not optional.
        await Promise.race([
          queue.getVersion(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("redis readiness check timed out")), READINESS_REDIS_TIMEOUT_MS),
          ),
        ]);
      } catch (err) {
        app.log.error({ err }, "readiness check failed (redis)");
        return reply.code(503).send({ status: "not_ready", reason: "redis_unreachable" });
      }
    }

    return { status: "ready" };
  });
}
