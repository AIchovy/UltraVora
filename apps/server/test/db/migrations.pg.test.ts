// Integration test against the real local PG (spec: 集成测试连本地真 PG 的独立库).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const testDbName = new URL(TEST_URL).pathname.slice(1);
if (!testDbName.endsWith("_test")) {
  throw new Error(
    `Refusing to run destructive migrations test against "${testDbName}" — name must end with _test`,
  );
}
if (!/^[a-z0-9_]+$/.test(testDbName)) {
  throw new Error(
    `Refusing to run destructive migrations test — database name "${testDbName}" contains unsafe characters`,
  );
}

let pool: pg.Pool;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    await admin
      .query(`CREATE DATABASE ${testDbName}`)
      .catch((err: { code?: string }) => {
        if (err.code !== "42P04") throw err; // 42P04 = duplicate_database
      });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Local PostgreSQL at ${ADMIN_URL} is required for this test. Original: ${message}`,
    );
  } finally {
    await admin.end();
  }
  pool = new pg.Pool({ connectionString: TEST_URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE;");
  await migrate(drizzle(pool), { migrationsFolder });
});

afterAll(async () => {
  await pool?.end();
});

describe("auth schema migrations", () => {
  it("creates the better-auth tables", async () => {
    const res = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    const names = res.rows.map((r: { table_name: string }) => r.table_name);
    for (const t of ["account", "session", "user", "verification"]) {
      expect(names).toContain(t);
    }
  });

  it("enforces unique user email", async () => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('u1', 'A', 'a@x.com', false, now(), now())`,
    );
    await expect(
      pool.query(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
         VALUES ('u2', 'B', 'a@x.com', false, now(), now())`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("creates creator_sessions with a cascading user FK", async () => {
    const res = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    const names = res.rows.map((r: { table_name: string }) => r.table_name);
    expect(names).toContain("creator_sessions");

    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('owner1', 'O', 'owner1@x.com', false, now(), now())`,
    );
    await pool.query(
      `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
       VALUES ('sess1', 'owner1', 'idle', now(), now())`,
    );
    await pool.query(`DELETE FROM "user" WHERE id='owner1'`);
    const after = await pool.query(`SELECT id FROM creator_sessions WHERE id='sess1'`);
    expect(after.rowCount).toBe(0);
  });

  it("creates session_events + artifacts and cascades them when the session is deleted", async () => {
    const tables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
    );
    const names = tables.rows.map((r: { table_name: string }) => r.table_name);
    expect(names).toContain("session_events");
    expect(names).toContain("artifacts");

    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('ev_owner', 'O', 'ev_owner@x.com', false, now(), now())`,
    );
    await pool.query(
      `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
       VALUES ('ev_sess', 'ev_owner', 'idle', now(), now())`,
    );
    await pool.query(
      `INSERT INTO session_events (session_id, seq, at, event)
       VALUES ('ev_sess', 1, now(), '{"type":"phase.progress","phase":"research","message":"x"}'::jsonb)`,
    );
    await pool.query(
      `INSERT INTO artifacts (session_id, kind, version, data, derived_from, stale, created_at)
       VALUES ('ev_sess', 'brief', 1, '{"x":1}'::jsonb, null, false, now())`,
    );

    await pool.query(`DELETE FROM creator_sessions WHERE id='ev_sess'`);
    const ev = await pool.query(`SELECT id FROM session_events WHERE session_id='ev_sess'`);
    const ar = await pool.query(`SELECT id FROM artifacts WHERE session_id='ev_sess'`);
    expect(ev.rowCount).toBe(0);
    expect(ar.rowCount).toBe(0);
  });

  it("creates session_messages with pending default and session cascade", async () => {
    const tables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
    );
    expect(tables.rows.map((r: { table_name: string }) => r.table_name)).toContain(
      "session_messages",
    );

    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('mq_owner', 'O', 'mq_owner@x.com', false, now(), now())`,
    );
    await pool.query(
      `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
       VALUES ('mq_sess', 'mq_owner', 'idle', now(), now())`,
    );
    await pool.query(
      `INSERT INTO session_messages (session_id, payload)
       VALUES ('mq_sess', '{"text":"make a video"}'::jsonb)`,
    );
    const row = await pool.query(
      `SELECT status, started_at, finished_at FROM session_messages WHERE session_id='mq_sess'`,
    );
    expect(row.rows[0]).toMatchObject({ status: "pending", started_at: null, finished_at: null });

    await pool.query(`DELETE FROM creator_sessions WHERE id='mq_sess'`);
    const after = await pool.query(
      `SELECT id FROM session_messages WHERE session_id='mq_sess'`,
    );
    expect(after.rowCount).toBe(0);
  });

  it("enforces unique (session_id, seq) and (session_id, kind, version)", async () => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('uq_owner', 'O', 'uq_owner@x.com', false, now(), now())`,
    );
    await pool.query(
      `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
       VALUES ('uq_sess', 'uq_owner', 'idle', now(), now())`,
    );
    await pool.query(
      `INSERT INTO session_events (session_id, seq, at, event)
       VALUES ('uq_sess', 1, now(), '{}'::jsonb)`,
    );
    await expect(
      pool.query(
        `INSERT INTO session_events (session_id, seq, at, event)
         VALUES ('uq_sess', 1, now(), '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/duplicate key/);

    await pool.query(
      `INSERT INTO artifacts (session_id, kind, version, data, stale, created_at)
       VALUES ('uq_sess', 'brief', 1, '{}'::jsonb, false, now())`,
    );
    await expect(
      pool.query(
        `INSERT INTO artifacts (session_id, kind, version, data, stale, created_at)
         VALUES ('uq_sess', 'brief', 1, '{}'::jsonb, false, now())`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});
