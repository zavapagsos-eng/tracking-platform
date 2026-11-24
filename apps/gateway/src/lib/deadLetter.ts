import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@tracking/db";

/**
 * Records (or refreshes) a Dead Letter row for a job that will never
 * succeed by retrying as-is — see the extended comment on
 * `schema.deadLetters` in packages/db/src/schema.ts for why this lives in
 * Postgres rather than only in BullMQ's own Redis-backed failed set.
 *
 * Idempotent on `(queue_name, job_id)`: a second failure of the same
 * logical job updates the existing row (latest reason/timestamp) instead of
 * accumulating duplicates for what is, semantically, still the same stuck
 * job.
 *
 * `attempts_made` counts how many times this job has landed here — one
 * per dead-lettering, summed across Reconciliation requeue cycles — so
 * `RECONCILIATION_MAX_REQUEUE_ATTEMPTS` really bounds the number of
 * requeues. It used to be overwritten with BullMQ's per-job attempt count,
 * which reset to 1 on every requeue (structural gaps retried forever) and
 * started at the queue's full attempt budget for a terminal Meta error
 * (transient errors were never requeued even once).
 */
export async function recordDeadLetter(
  db: Database,
  params: {
    queueName: string;
    jobId: string;
    jobData: unknown;
    failureReason: string;
  },
): Promise<void> {
  await db
    .insert(schema.deadLetters)
    .values({
      queueName: params.queueName,
      jobId: params.jobId,
      jobData: params.jobData,
      failureReason: params.failureReason,
      attemptsMade: 1,
    })
    .onConflictDoUpdate({
      target: [schema.deadLetters.queueName, schema.deadLetters.jobId],
      set: {
        failureReason: params.failureReason,
        attemptsMade: sql`${schema.deadLetters.attemptsMade} + 1`,
        lastFailedAt: new Date(),
      },
    });
}

export async function getDeadLetter(db: Database, params: { queueName: string; jobId: string }) {
  const [row] = await db
    .select()
    .from(schema.deadLetters)
    .where(and(eq(schema.deadLetters.queueName, params.queueName), eq(schema.deadLetters.jobId, params.jobId)))
    .limit(1);
  return row;
}

/**
 * Removes a Dead Letter row once its job is known to have succeeded —
 * used by the Reconciliation Engine (Phase 12) so an order that failed,
 * was requeued, and eventually delivered doesn't keep showing up as a
 * "current problem" in `dead_letters` forever. Harmless no-op if no row
 * exists for this (queue_name, job_id).
 */
export async function deleteDeadLetter(db: Database, params: { queueName: string; jobId: string }): Promise<void> {
  await db
    .delete(schema.deadLetters)
    .where(and(eq(schema.deadLetters.queueName, params.queueName), eq(schema.deadLetters.jobId, params.jobId)));
}
