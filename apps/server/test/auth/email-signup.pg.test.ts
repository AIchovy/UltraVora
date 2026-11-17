// Integration test against real local PG: email signup sends a 6-digit code,
// verification flips emailVerified + issues a session, and login is gated on it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as schema from "../../src/db/schema/index.js";
import { createDb, type Db } from "../../src/db/client.js";
import { createAuth } from "../../src/auth/better-auth.js";
import type { EmailService } from "../../src/email/email-service.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const dbName = new URL(TEST_URL).pathname.slice(1);
if (!dbName.endsWith("_test") || !/^[a-z0-9_]+$/.test(dbName)) {
  throw new Error(`Refusing to run against unsafe test DB name "${dbName}"`);
}

let pool: pg.Pool;
let db: Db;
const sent: { to: string; code: string }[] = [];
const fakeEmail: EmailService = {
  async sendVerificationCode({ to, code }) {
    sent.push({ to, code });
  },
};

function buildAuth() {
  return createAuth({
    db,
    baseURL: "http://localhost:3000",
    secret: "test-secret-test-secret-test-secret-0000",
    google: { clientId: "id", clientSecret: "secret" },
    email: fakeEmail,
    otpExpiresMinutes: 15,
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${dbName}`).catch((e: { code?: string }) => {
    if (e.code !== "42P04") throw e;
  });
  await admin.end();
  ({ db, pool } = createDb(TEST_URL));
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  // The drizzle migration journal lives in its own schema; drop it too so
  // migrate() re-applies every migration into the freshly-emptied public schema
  // (otherwise it sees them as already applied and creates no tables).
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE;");
  await migrate(db, { migrationsFolder });
});

afterAll(async () => {
  await pool?.end();
});

describe("email signup + verification (PG)", () => {
  const email = "newuser@example.com";
  const password = "Abcdef12345!"; // valid per policy

  it("rejects a weak password with 400 and creates no user", async () => {
    const auth = buildAuth();
    const res = await auth.handler(post("/sign-up/email", { email: "weak@example.com", password: "short1!", name: "weak" }));
    expect(res.status).toBe(400);
    const rows = await db.select().from(schema.user).where(eq(schema.user.email, "weak@example.com"));
    expect(rows).toHaveLength(0);
  });

  it("rejects an invalid nickname with 400 and creates no user", async () => {
    const auth = buildAuth();
    const res = await auth.handler(post("/sign-up/email", { email: "nick@example.com", password, name: "x" }));
    expect(res.status).toBe(400);
    const rows = await db.select().from(schema.user).where(eq(schema.user.email, "nick@example.com"));
    expect(rows).toHaveLength(0);
  });

  it("signs up, emails a 6-digit code, and leaves the email unverified", async () => {
    const auth = buildAuth();
    sent.length = 0;
    const res = await auth.handler(post("/sign-up/email", { email, password, name: "newuser" }));
    expect(res.status).toBeLessThan(400);
    const mine = sent.filter((s) => s.to === email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.code).toMatch(/^\d{6}$/);
    const u = (await db.select().from(schema.user).where(eq(schema.user.email, email)))[0]!;
    expect(u.emailVerified).toBe(false);
  });

  it("blocks password login before verification", async () => {
    const auth = buildAuth();
    const res = await auth.handler(post("/sign-in/email", { email, password }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("verifies with the emailed code, flips emailVerified, and then allows login", async () => {
    const auth = buildAuth();
    const code = sent.filter((s) => s.to === email).at(-1)!.code;
    const verifyRes = await auth.handler(post("/email-otp/verify-email", { email, otp: code }));
    expect(verifyRes.status).toBeLessThan(400);
    // Verification auto-signs-in: the same response issues the session cookie,
    // so the user lands on the app already authenticated (no extra login step).
    expect(verifyRes.headers.getSetCookie().join(";")).toContain("better-auth");
    const u = (await db.select().from(schema.user).where(eq(schema.user.email, email)))[0]!;
    expect(u.emailVerified).toBe(true);

    const loginRes = await auth.handler(post("/sign-in/email", { email, password }));
    expect(loginRes.status).toBeLessThan(400);
    expect(loginRes.headers.getSetCookie().join(";")).toContain("better-auth");
  });
});
