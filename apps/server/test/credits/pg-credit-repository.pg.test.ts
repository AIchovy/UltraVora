// PG twin of credit-repository.test.ts — same contract against real Postgres,
// plus the atomicity guarantee the in-memory fake can't exercise (concurrent
// debits must never overdraw).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgCreditRepository } from "../../src/credits/pg-credit-repository.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const testDbName = new URL(TEST_URL).pathname.slice(1);
if (!testDbName.endsWith("_test") || !/^[a-z0-9_]+$/.test(testDbName)) {
  throw new Error(`Refusing destructive test against "${testDbName}"`);
}

let pool: pg.Pool;
let repo: PgCreditRepository;

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
  repo = new PgCreditRepository(drizzle(pool));
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE credit_balance, credit_ledger, subscription, "user" CASCADE');
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','U1','u1@x.com',false,now(),now()), ('u2','U2','u2@x.com',false,now(),now())`,
  );
});

describe("PgCreditRepository", () => {
  it("balance defaults to 0", async () => {
    expect(await repo.getBalance("u1")).toBe(0);
  });

  it("grant adds credits and is idempotent", async () => {
    expect(await repo.grant({ userId: "u1", amount: 200, idempotencyKey: "signup:u1", reason: "signup_bonus" }))
      .toEqual({ balanceAfter: 200, deduplicated: false });
    expect(await repo.grant({ userId: "u1", amount: 200, idempotencyKey: "signup:u1", reason: "signup_bonus" }))
      .toEqual({ balanceAfter: 200, deduplicated: true });
    expect(await repo.getBalance("u1")).toBe(200);
  });

  it("debit returns insufficient without mutating", async () => {
    await repo.grant({ userId: "u1", amount: 100, idempotencyKey: "g1", reason: "purchase" });
    expect(await repo.debit({ userId: "u1", amount: 160, idempotencyKey: "s1:compose", reason: "consumption" }))
      .toEqual({ ok: false, reason: "insufficient", balance: 100, needed: 160 });
    expect(await repo.getBalance("u1")).toBe(100);
  });

  it("debit deducts and is idempotent", async () => {
    await repo.grant({ userId: "u1", amount: 200, idempotencyKey: "g1", reason: "signup_bonus" });
    expect(await repo.debit({ userId: "u1", amount: 60, idempotencyKey: "s1:research", reason: "consumption" }))
      .toEqual({ ok: true, balanceAfter: 140, deduplicated: false });
    expect(await repo.debit({ userId: "u1", amount: 60, idempotencyKey: "s1:research", reason: "consumption" }))
      .toEqual({ ok: true, balanceAfter: 140, deduplicated: true });
    expect(await repo.getBalance("u1")).toBe(140);
  });

  it("concurrent debits never overdraw (FOR UPDATE serialization)", async () => {
    await repo.grant({ userId: "u1", amount: 100, idempotencyKey: "g1", reason: "purchase" });
    const [a, b] = await Promise.all([
      repo.debit({ userId: "u1", amount: 60, idempotencyKey: "s1:a", reason: "consumption" }),
      repo.debit({ userId: "u1", amount: 60, idempotencyKey: "s2:b", reason: "consumption" }),
    ]);
    const oks = [a, b].filter((r) => r.ok).length;
    expect(oks).toBe(1); // exactly one of two 60-credit debits succeeds against 100
    expect(await repo.getBalance("u1")).toBe(40);
  });

  it("grant routes to buckets; resetSubscriptionCredits sets (no roll-over); debit draws sub→bonus→purchased", async () => {
    await repo.grant({ userId: "u1", amount: 200, idempotencyKey: "bonus", reason: "signup_bonus" });
    await repo.grant({ userId: "u1", amount: 500, idempotencyKey: "buy", reason: "purchase" });
    await repo.resetSubscriptionCredits({ userId: "u1", amount: 300, idempotencyKey: "sub:p1", reason: "subscription_grant" });
    expect(await repo.getBreakdown("u1")).toEqual({ subscription: 300, bonus: 200, purchased: 500 });
    expect(await repo.getBalance("u1")).toBe(1000);

    // Reset again (next period) — subscription is replaced, not accumulated.
    await repo.resetSubscriptionCredits({ userId: "u1", amount: 300, idempotencyKey: "sub:p2", reason: "subscription_grant" });
    expect((await repo.getBreakdown("u1")).subscription).toBe(300);

    // Spend 600: drains subscription(300) + bonus(200) + 100 of purchased.
    const r = await repo.debit({ userId: "u1", amount: 600, idempotencyKey: "spend", reason: "consumption" });
    expect(r).toEqual({ ok: true, balanceAfter: 400, deduplicated: false });
    expect(await repo.getBreakdown("u1")).toEqual({ subscription: 0, bonus: 0, purchased: 400 });
  });

  it("stores and reads back a subscription (incl. provider linkage ids)", async () => {
    expect(await repo.getSubscription("u1")).toBeNull();
    const sub = {
      userId: "u1",
      tier: "pro" as const,
      status: "active" as const,
      interval: "monthly" as const,
      currentPeriodEnd: "2026-07-25T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    };
    await repo.setSubscription(sub);
    // Absent provider ids read back as explicit nulls from PG.
    expect(await repo.getSubscription("u1")).toEqual({
      ...sub,
      providerCustomerId: null,
      providerSubscriptionId: null,
    });

    await repo.setSubscription({ ...sub, providerCustomerId: "cust_1", providerSubscriptionId: "sub_1" });
    expect(await repo.getSubscription("u1")).toMatchObject({
      providerCustomerId: "cust_1",
      providerSubscriptionId: "sub_1",
    });
  });
});
