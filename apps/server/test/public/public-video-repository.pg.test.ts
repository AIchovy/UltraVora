// apps/server/test/public/public-video-repository.pg.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgSessionRepository } from "../../src/sessions/pg-session-repository.js";
import { PgPublicVideoRepository } from "../../src/public/pg-public-video-repository.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const testDbName = new URL(TEST_URL).pathname.slice(1);

let pool: pg.Pool;
let sessions: PgSessionRepository;
let pv: PgPublicVideoRepository;

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
  sessions = new PgSessionRepository(drizzle(pool));
  pv = new PgPublicVideoRepository(drizzle(pool));
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE video_likes, creator_sessions, "user" CASCADE');
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','Ann','a@x.com',false,now(),now())`,
  );
});

describe("PgPublicVideoRepository", () => {
  it("lists only public+done videos and toggles likes", async () => {
    await sessions.create({ id: "pub", userId: "u1", isPublic: true, productUrl: "https://a.com" });
    await sessions.updateStatus("pub", { status: "done", currentPhase: "render", error: null });
    await sessions.create({ id: "priv", userId: "u1", isPublic: false });
    await sessions.updateStatus("priv", { status: "done", currentPhase: "render", error: null });
    await sessions.create({ id: "running", userId: "u1", isPublic: true }); // not done → excluded

    const list = await pv.list({ sort: "recent", limit: 10 });
    expect(list.map((v) => v.sid)).toEqual(["pub"]);
    expect(list[0]!.author.name).toBe("Ann");

    expect(await pv.like("pub", "u1")).toEqual({ likeCount: 1, liked: true });
    expect(await pv.like("pub", "u1")).toEqual({ likeCount: 1, liked: true }); // idempotent
    const asViewer = await pv.get("pub", "u1");
    expect(asViewer?.likedByMe).toBe(true);
    expect(await pv.unlike("pub", "u1")).toEqual({ likeCount: 0, liked: false });
  });
});
