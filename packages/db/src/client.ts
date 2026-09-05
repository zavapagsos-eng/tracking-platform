import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

/** Creates a Drizzle client backed by a `pg.Pool`. Callers own the pool's
 * lifecycle (call `pool.end()` on shutdown). */
export function createDatabase(connectionString: string): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export * as schema from "./schema.js";
