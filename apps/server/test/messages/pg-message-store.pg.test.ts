import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgMessageStore } from "../../src/messages/pg-message-store.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
// Shares ultracreator_test with the other *.pg.test.ts files — safe because the
// "pg" vitest project runs them single-fork, one file at a time.
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const testDbName = new URL(TEST_URL).pathname.slice(1);
if (!testDbName.endsWith("_test") || !/^[a-z0-9_]+$/.test(testDbName)) {
  throw new Error(`Refusing destructive test against "${testDbName}"`);
}

let pool: pg.Pool;
let store: PgMessageStore;

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
  store = new PgMessageStore(drizzle(pool));
});

afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await pool.query('TRUNCATE session_messages, creator_sessions, "user" CASCADE');
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','U1','u1@x.com',false,now(),now())`,
  );
  await pool.query(
    `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
     VALUES ('s1','u1','idle',now(),now()), ('s2','u1','idle',now(),now())`,
  );
});

describe("PgMessageStore", () => {
  it("insert creates a pending row and returns its id; payload round-trips", async () => {
    const id = await store.insert("s1", {
      text: "make a video",
      uploadedFiles: ["a.png"],
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    const rows = await store.listIncomplete();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, sessionId: "s1", status: "pending", startedAt: null, finishedAt: null });
    expect(rows[0]!.payload).toEqual({
      text: "make a video",
      uploadedFiles: ["a.png"],
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(typeof rows[0]!.createdAt).toBe("string");
  });

  it("markProcessing/markDone/markError advance status and stamp timestamps", async () => {
    const id = await store.insert("s1", { text: "x" });
    await store.markProcessing(id);
    const rows = await store.listIncomplete();
    const row = rows[0]!;
    expect(row.status).toBe("processing");
    expect(row.startedAt).not.toBeNull();

    await store.markDone(id);
    expect(await store.listIncomplete()).toHaveLength(0);
    const done = await pool.query("SELECT status, finished_at FROM session_messages WHERE id=$1", [id]);
    expect(done.rows[0]!.status).toBe("done");
    expect(done.rows[0]!.finished_at).not.toBeNull();

    const id2 = await store.insert("s1", { text: "y" });
    await store.markError(id2);
    const err = await pool.query("SELECT status, finished_at FROM session_messages WHERE id=$1", [id2]);
    expect(err.rows[0]!.status).toBe("error");
    expect(err.rows[0]!.finished_at).not.toBeNull();
  });

  it("mark* on an absent id is a silent no-op", async () => {
    await expect(store.markProcessing(424242)).resolves.toBeUndefined();
    await expect(store.markDone(424242)).resolves.toBeUndefined();
    await expect(store.markError(424242)).resolves.toBeUndefined();
  });

  it("listIncomplete spans sessions, id ascending, excluding done/error", async () => {
    const a = await store.insert("s1", { text: "a" });
    const b = await store.insert("s2", { text: "b" });
    const c = await store.insert("s1", { text: "c" });
    const d = await store.insert("s2", { text: "d" });
    await store.markProcessing(a);
    await store.markDone(c);
    await store.markError(d);
    const rows = await store.listIncomplete();
    expect(rows.map((r) => r.id)).toEqual([a, b]);
    expect(rows.map((r) => r.status)).toEqual(["processing", "pending"]);
  });

  it("insert for a missing session rejects (FK) — user messages must not be silently dropped", async () => {
    await expect(store.insert("ghost", { text: "x" })).rejects.toThrow();
  });
});
