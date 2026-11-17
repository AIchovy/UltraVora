import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgArtifactRepository } from "../../src/artifacts/pg-artifact-repository.js";
import type { ArtifactRow } from "../../src/artifacts/artifact-repository.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
// Shares ultracreator_test; safe under the single-fork "pg" project (see vitest.suites.ts).
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const testDbName = new URL(TEST_URL).pathname.slice(1);
if (!testDbName.endsWith("_test") || !/^[a-z0-9_]+$/.test(testDbName)) {
  throw new Error(`Refusing destructive test against "${testDbName}"`);
}

let pool: pg.Pool;
let repo: PgArtifactRepository;

const row = (kind: ArtifactRow["kind"], version: number, extra: Partial<ArtifactRow> = {}): ArtifactRow => ({
  kind,
  version,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, version)).toISOString(),
  derivedFrom: null,
  stale: false,
  data: { v: version },
  ...extra,
});

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
  repo = new PgArtifactRepository(drizzle(pool));
});

afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await pool.query('TRUNCATE artifacts, creator_sessions, "user" CASCADE');
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','U1','u1@x.com',false,now(),now())`,
  );
  await pool.query(
    `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
     VALUES ('s1','u1','idle',now(),now()), ('s2','u1','idle',now(),now())`,
  );
});

describe("PgArtifactRepository", () => {
  it("maxVersion is 0 then tracks the highest per kind", async () => {
    expect(await repo.maxVersion("s1", "brief")).toBe(0);
    await repo.insert("s1", row("brief", 1));
    await repo.insert("s1", row("brief", 2));
    await repo.insert("s1", row("design", 1));
    expect(await repo.maxVersion("s1", "brief")).toBe(2);
    expect(await repo.maxVersion("s1", "design")).toBe(1);
  });

  it("getLatest / getVersion round-trip data, createdAt (ISO) and derivedFrom", async () => {
    await repo.insert("s1", row("brief", 1, { data: { a: 1 } }));
    await repo.insert("s1", row("design", 1, { data: { d: 1 }, derivedFrom: [{ kind: "brief", version: 1 }] }));
    const latest = await repo.getLatest("s1", "design");
    expect(latest?.data).toEqual({ d: 1 });
    expect(latest?.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
    expect(latest?.createdAt).toBe(row("design", 1).createdAt);
    expect((await repo.getVersion("s1", "brief", 1))?.data).toEqual({ a: 1 });
    expect(await repo.getVersion("s1", "brief", 9)).toBeNull();
    expect(await repo.getLatest("s2", "brief")).toBeNull();
  });

  it("list returns every row, scoped per session", async () => {
    await repo.insert("s1", row("brief", 1));
    await repo.insert("s1", row("design", 1));
    await repo.insert("s2", row("brief", 1));
    expect((await repo.list("s1")).map((r) => r.kind).sort()).toEqual(["brief", "design"]);
    expect((await repo.list("s2")).map((r) => r.kind)).toEqual(["brief"]);
  });

  it("markStale flips the flag and returns false for a missing row", async () => {
    await repo.insert("s1", row("brief", 1));
    expect(await repo.markStale("s1", "brief", 1)).toBe(true);
    expect((await repo.getVersion("s1", "brief", 1))?.stale).toBe(true);
    expect(await repo.markStale("s1", "brief", 2)).toBe(false);
  });

  it("rejects a duplicate (session, kind, version)", async () => {
    await repo.insert("s1", row("brief", 1));
    await expect(repo.insert("s1", row("brief", 1))).rejects.toThrow();
  });
});
