// apps/server/test/sessions/free-grant.pg.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgSessionRepository } from "../../src/sessions/pg-session-repository.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const testDbName = new URL(TEST_URL).pathname.slice(1);

let pool: pg.Pool;
let repo: PgSessionRepository;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${testDbName}`).catch((e: { code?: string }) => {
    if (e.code !== "42P04") throw e; // ignore "already exists"
  });
  await admin.end();
  pool = new pg.Pool({ connectionString: TEST_URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE;");
  await migrate(drizzle(pool), { migrationsFolder });
  repo = new PgSessionRepository(drizzle(pool));
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE creator_sessions, "user" CASCADE');
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','U1','u1@x.com',false,now(),now())`,
  );
});

describe("PgSessionRepository free public grant", () => {
  it("grants once per account", async () => {
    await repo.create({ id: "a", userId: "u1", isPublic: true });
    await repo.create({ id: "b", userId: "u1", isPublic: true });
    expect(await repo.claimFreePublicGrant("a", "u1")).toBe(true);
    expect(await repo.claimFreePublicGrant("b", "u1")).toBe(false);
    expect(await repo.claimFreePublicGrant("a", "u1")).toBe(true);
    expect(await repo.hasFreePublicGrant("u1")).toBe(true);
  });
});
