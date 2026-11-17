import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgSessionRepository } from "../../src/sessions/pg-session-repository.js";

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
let repo: PgSessionRepository;

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
  repo = new PgSessionRepository(drizzle(pool));
});

afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await pool.query("TRUNCATE creator_sessions, \"user\" CASCADE");
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','U1','u1@x.com',false,now(),now()), ('u2','U2','u2@x.com',false,now(),now())`,
  );
});

describe("PgSessionRepository", () => {
  it("create + get yields an idle untitled owned record", async () => {
    await repo.create({ id: "s1", userId: "u1" });
    expect(await repo.get("s1")).toMatchObject({ id: "s1", userId: "u1", title: null, status: "idle" });
  });

  it("create is idempotent", async () => {
    await repo.create({ id: "s1", userId: "u1" });
    await repo.create({ id: "s1", userId: "u1" });
    expect(await repo.get("s1")).not.toBeNull();
  });

  it("listByUser is scoped to the owner", async () => {
    await repo.create({ id: "a", userId: "u1" });
    await repo.create({ id: "b", userId: "u1" });
    await repo.create({ id: "c", userId: "u2" });
    expect((await repo.listByUser("u1")).map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect((await repo.listByUser("u2")).map((r) => r.id)).toEqual(["c"]);
  });

  it("listByUser returns rows ordered by updatedAt descending", async () => {
    await repo.create({ id: "a", userId: "u1" });
    await repo.create({ id: "b", userId: "u1" });
    await repo.create({ id: "x", userId: "u1" });
    // Set distinct, known timestamps so ordering is deterministic (no wall-clock ties).
    await pool.query("UPDATE creator_sessions SET updated_at = $2 WHERE id = $1", ["a", new Date("2026-01-01T00:00:03Z")]);
    await pool.query("UPDATE creator_sessions SET updated_at = $2 WHERE id = $1", ["b", new Date("2026-01-01T00:00:02Z")]);
    await pool.query("UPDATE creator_sessions SET updated_at = $2 WHERE id = $1", ["x", new Date("2026-01-01T00:00:01Z")]);
    expect((await repo.listByUser("u1")).map((r) => r.id)).toEqual(["a", "b", "x"]);
  });

  it("updateStatus persists kind/phase/error and is a no-op when absent", async () => {
    await repo.create({ id: "s1", userId: "u1" });
    await repo.updateStatus("s1", { status: "error", currentPhase: "design", error: "boom", pendingRefinement: null });
    expect(await repo.get("s1")).toMatchObject({ status: "error", currentPhase: "design", error: "boom" });
    await repo.updateStatus("ghost", { status: "running", currentPhase: "research", error: null, pendingRefinement: null });
    expect(await repo.get("ghost")).toBeNull();
  });

  it("round-trips a parked refinement and bumps the run counter", async () => {
    await repo.create({ id: "s1", userId: "u1" });
    expect((await repo.get("s1"))?.runSeq).toBe(0);
    await repo.updateStatus("s1", {
      status: "awaiting-credits", currentPhase: "compose", error: null,
      pendingRefinement: "make the headline blue",
    });
    expect(await repo.get("s1")).toMatchObject({
      status: "awaiting-credits", pendingRefinement: "make the headline blue",
    });
    expect(await repo.incrementRunSeq("s1")).toBe(1);
    expect(await repo.incrementRunSeq("s1")).toBe(2);
    expect((await repo.get("s1"))?.runSeq).toBe(2);
    expect(await repo.incrementRunSeq("ghost")).toBe(0); // plain UPDATE semantics
  });

  it("setTitleIfEmpty only sets once", async () => {
    await repo.create({ id: "s1", userId: "u1" });
    await repo.setTitleIfEmpty("s1", "First");
    await repo.setTitleIfEmpty("s1", "Second");
    expect((await repo.get("s1"))?.title).toBe("First");
  });

  it("delete removes the row", async () => {
    await repo.create({ id: "s1", userId: "u1" });
    await repo.delete("s1");
    expect(await repo.get("s1")).toBeNull();
  });

  it("create stores autoApprove", async () => {
    await repo.create({ id: "s-aa", userId: "u1", autoApprove: true });
    expect((await repo.get("s-aa"))?.autoApprove).toBe(true);
  });

  it("setAutoApprove toggles the flag", async () => {
    await repo.create({ id: "s-aa-toggle", userId: "u1", autoApprove: true });
    await repo.setAutoApprove("s-aa-toggle", false);
    expect((await repo.get("s-aa-toggle"))?.autoApprove).toBe(false);
  });

  it("setAutoApprove is a no-op when the row is absent", async () => {
    await repo.setAutoApprove("ghost-aa", true);
    expect(await repo.get("ghost-aa")).toBeNull();
  });

  it("create defaults autoApprove to false when omitted", async () => {
    await repo.create({ id: "s-def", userId: "u1" });
    expect((await repo.get("s-def"))?.autoApprove).toBe(false);
  });
});
