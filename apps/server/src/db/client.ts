import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(databaseUrl: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // node-postgres emits 'error' for idle-client failures (PG restart, network
  // blip); without a listener Node crashes the whole process.
  pool.on("error", (err) => {
    console.error("pg pool idle client error", err);
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
