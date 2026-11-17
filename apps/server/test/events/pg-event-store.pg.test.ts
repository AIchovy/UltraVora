import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ServerEvent } from "@ultracreator/shared";
import { PgEventStore } from "../../src/events/pg-event-store.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
// Shares the ultracreator_test DB with the other *.pg.test.ts files. Safe because
// the "pg" vitest project (vitest.suites.ts) runs every *.pg.test.ts single-fork,
// one file at a time — each beforeAll drops+migrates fresh, so they never race.
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const testDbName = new URL(TEST_URL).pathname.slice(1);
if (!testDbName.endsWith("_test") || !/^[a-z0-9_]+$/.test(testDbName)) {
  throw new Error(`Refusing destructive test against "${testDbName}"`);
}

let pool: pg.Pool;
let store: PgEventStore;

const ev = (i: number): ServerEvent => ({ type: "phase.progress", phase: "research", message: `m${i}` });
const entry = (seq: number) => ({ seq, at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), event: ev(seq) });

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${testDbName}`).catch((e: { code?: string }) => {
    if (e.code !== "42P04") throw e;
  });
  await admin.end();
  pool = new pg.Pool({ connectionString: TEST_URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE;");
  await migrate(drizzle(pool), { migrationsFolder });
  store = new PgEventStore(drizzle(pool));
});

afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await pool.query('TRUNCATE session_events, creator_sessions, "user" CASCADE');
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','U1','u1@x.com',false,now(),now())`,
  );
  await pool.query(
    `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
     VALUES ('s1','u1','idle',now(),now()), ('s2','u1','idle',now(),now())`,
  );
});

async function collect(it: AsyncIterable<{ seq: number; at: string }>): Promise<{ seq: number; at: string }[]> {
  const out: { seq: number; at: string }[] = [];
  for await (const e of it) out.push({ seq: e.seq, at: e.at });
  return out;
}

describe("PgEventStore", () => {
  it("maxSeq is 0 before any append", async () => {
    expect(await store.maxSeq("s1")).toBe(0);
  });

  it("append + maxSeq + readSince round-trips and preserves event + ISO at", async () => {
    await store.append("s1", [entry(1), entry(2), entry(3)]);
    expect(await store.maxSeq("s1")).toBe(3);
    const rows = await collect(store.readSince("s1", 1));
    expect(rows.map((r) => r.seq)).toEqual([2, 3]);
    expect(rows[0]!.at).toBe(entry(2).at); // lossless ISO round-trip
  });

  it("readSince(0) yields all; readSince is scoped per session", async () => {
    await store.append("s1", [entry(1), entry(2)]);
    await store.append("s2", [entry(1)]);
    const s1 = await collect(store.readSince("s1", 0));
    const s2 = await collect(store.readSince("s2", 0));
    expect(s1.map((r) => r.seq)).toEqual([1, 2]);
    expect(s2.map((r) => r.seq)).toEqual([1]);
  });

  it("append of an empty batch is a no-op", async () => {
    await store.append("s1", []);
    expect(await store.maxSeq("s1")).toBe(0);
  });

  it("append for a deleted session is swallowed (FK violation ignored)", async () => {
    await pool.query(`DELETE FROM creator_sessions WHERE id='s2'`);
    await expect(store.append("s2", [entry(1)])).resolves.toBeUndefined();
    expect(await store.maxSeq("s2")).toBe(0);
  });
});
