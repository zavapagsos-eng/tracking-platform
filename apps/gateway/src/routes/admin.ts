import { desc } from "drizzle-orm";
import { schema } from "@tracking/db";
import type { FastifyInstance } from "fastify";
import { requireAdminAuth } from "../lib/adminAuth.js";
import { reconstructJourneyByOrderId } from "../lib/journey.js";
import { requeueEligibleOrders, runReconciliation } from "../lib/reconciliation.js";

/**
 * Read-only Admin/Dashboard API (Phase 13, docs/ARCHITECTURE.md's
 * component diagram: "Admin/Dashboard (leitura)"). Every route here is
 * JSON, not a rendered UI — this project's own scope is a backend
 * tracking platform, and a JSON API a human (or a future separate
 * frontend) can query already satisfies the phase's own completion
 * criterion ("Cobertura visível para um pedido de teste") without
 * building a frontend nobody asked for.
 *
 * Every route is gated by `requireAdminAuth` (HTTP Basic Auth, see
 * lib/adminAuth.ts) via a preHandler hook scoped to `/admin/*` — fails
 * closed (501) if the admin account isn't configured at all, 401
 * otherwise until valid credentials are presented.
 */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/admin/")) return;
    await requireAdminAuth(app.config, request, reply);
  });

  /**
   * Journey Inspector (docs/ARCHITECTURE.md: "Journey Inspector... a
   * partir de order_id") — a direct, thin wrapper over
   * `reconstructJourneyByOrderId` (Phase 9). Every non-"ok" status it can
   * return is a real, named, expected outcome (no checkout correlation,
   * checkout never tracked, session never tracked, order not found) —
   * surfaced here as 404 with that exact reason, never collapsed into a
   * generic error.
   */
  app.get<{ Params: { orderId: string } }>("/admin/journey/:orderId", async (request, reply) => {
    const result = await reconstructJourneyByOrderId(app.db, request.params.orderId);
    if (result.status !== "ok") {
      return reply.code(404).send(result);
    }
    return reply.code(200).send(result);
  });

  /** Recent reconciliation runs (Phase 12), newest first. */
  app.get("/admin/reconciliation/runs", async (request, reply) => {
    const query = request.query as { limit?: string };
    const parsedLimit = Number(query.limit);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 && parsedLimit <= 100 ? parsedLimit : 20;

    const runs = await app.db
      .select()
      .from(schema.reconciliationRuns)
      .orderBy(desc(schema.reconciliationRuns.startedAt))
      .limit(limit);
    return reply.code(200).send({ runs });
  });

  /**
   * Triggers one reconciliation cycle on demand — the same
   * scan-then-bounded-requeue `src/reconciliationCron.ts` runs on its own
   * schedule, exposed here for an operator who doesn't want to wait for
   * the next tick. Requeue only happens when `app.metaQueue` exists
   * (REDIS_URL configured) — otherwise this is scan-only, same fail-open
   * shape as `runReconciliationCycle`.
   */
  app.post("/admin/reconciliation/run", async (request, reply) => {
    const result = await runReconciliation(app.db, app.config);
    let requeuedCount = 0;
    if (app.metaQueue) {
      const outcomes = await requeueEligibleOrders(app.db, app.metaQueue, app.config, result.details);
      requeuedCount = outcomes.filter((o) => o.requeued).length;
    }
    return reply.code(200).send({ summary: result.summary, details: result.details, requeuedCount });
  });

  /** Current Dead Letters (Phase 11/12) — what still needs attention,
   * most recently failed first. */
  app.get("/admin/dead-letters", async (request, reply) => {
    const query = request.query as { limit?: string };
    const parsedLimit = Number(query.limit);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 && parsedLimit <= 200 ? parsedLimit : 50;

    const deadLetters = await app.db
      .select()
      .from(schema.deadLetters)
      .orderBy(desc(schema.deadLetters.lastFailedAt))
      .limit(limit);
    return reply.code(200).send({ deadLetters });
  });
}
