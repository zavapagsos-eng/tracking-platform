import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@tracking/db";

/**
 * Records (or refreshes) a Dead Letter row for a job that will never
 * succeed by retrying as-is — see the extended comment on
 * `schema.deadLetters` in packages/db/src/schema.ts for why this lives in
 * Postgres rather than only in BullMQ's own Redis-backed failed set.
 *
 * Idempotent on `(queue_name, job_id)`: a second failure of the same
 * logical job updates the existing row (latest reason/attempt count/
 * timestamp) instead of accumulating duplicates for what is, semantically,
 * still the same stuck job.
 */
export async function recordDeadLetter(
  db: Database,
  params: {
    queueName: string;
    jobId: string;
    jobData: unknown;
    failureReason: string;
    attemptsMade: number;
  },
): Promise<void> {
  await db
    .insert(schema.deadLetters)
    .values({
      queueName: params.queueName,
      jobId: params.jobId,
      jobData: params.jobData,
      failureReason: params.failureReason,
      attemptsMade: params.attemptsMade,
    })
    .onConflictDoUpdate({
      target: [schema.deadLetters.queueName, schema.deadLetters.jobId],
      set: {
        failureReason: params.failureReason,
        attemptsMade: params.attemptsMade,
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
