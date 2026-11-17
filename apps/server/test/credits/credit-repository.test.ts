// Unit contract for CreditRepository, exercised against the in-memory impl. The
// PG twin (pg-credit-repository.pg.test.ts) asserts the same behaviors against
// real Postgres — the two MUST behave identically (same contract as
// SessionRepository's fake/PG pair).
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryCreditRepository } from "../../src/credits/memory-credit-repository.js";
import type { CreditRepository } from "../../src/credits/credit-repository.js";

let repo: CreditRepository;
beforeEach(() => {
  repo = new MemoryCreditRepository();
});

describe("balance", () => {
  it("defaults to 0 for an unknown user", async () => {
    expect(await repo.getBalance("u1")).toBe(0);
  });
});

describe("grant", () => {
  it("adds credits and reports the new balance", async () => {
    const r = await repo.grant({ userId: "u1", amount: 200, idempotencyKey: "signup:u1", reason: "signup_bonus" });
    expect(r).toEqual({ balanceAfter: 200, deduplicated: false });
    expect(await repo.getBalance("u1")).toBe(200);
  });

  it("is idempotent on idempotencyKey (no double grant)", async () => {
    await repo.grant({ userId: "u1", amount: 200, idempotencyKey: "signup:u1", reason: "signup_bonus" });
    const again = await repo.grant({ userId: "u1", amount: 200, idempotencyKey: "signup:u1", reason: "signup_bonus" });
    expect(again).toEqual({ balanceAfter: 200, deduplicated: true });
    expect(await repo.getBalance("u1")).toBe(200);
  });
});

describe("debit", () => {
  it("returns insufficient and does NOT mutate when balance < amount", async () => {
    await repo.grant({ userId: "u1", amount: 100, idempotencyKey: "g1", reason: "purchase" });
    const r = await repo.debit({ userId: "u1", amount: 160, idempotencyKey: "s1:compose:0", reason: "consumption" });
    expect(r).toEqual({ ok: false, reason: "insufficient", balance: 100, needed: 160 });
    expect(await repo.getBalance("u1")).toBe(100);
  });

  it("deducts and reports the new balance when affordable", async () => {
    await repo.grant({ userId: "u1", amount: 200, idempotencyKey: "g1", reason: "signup_bonus" });
    const r = await repo.debit({ userId: "u1", amount: 60, idempotencyKey: "s1:research:0", reason: "consumption" });
    expect(r).toEqual({ ok: true, balanceAfter: 140, deduplicated: false });
    expect(await repo.getBalance("u1")).toBe(140);
  });

  it("is idempotent on idempotencyKey (resume never double-charges a paid op)", async () => {
    await repo.grant({ userId: "u1", amount: 200, idempotencyKey: "g1", reason: "signup_bonus" });
    await repo.debit({ userId: "u1", amount: 60, idempotencyKey: "s1:research:0", reason: "consumption" });
    const again = await repo.debit({ userId: "u1", amount: 60, idempotencyKey: "s1:research:0", reason: "consumption" });
    expect(again).toEqual({ ok: true, balanceAfter: 140, deduplicated: true });
    expect(await repo.getBalance("u1")).toBe(140);
  });

  it("rejects a non-positive amount", async () => {
    await expect(repo.debit({ userId: "u1", amount: 0, idempotencyKey: "x", reason: "consumption" })).rejects.toThrow();
  });
});

describe("buckets (subscription / bonus / purchased)", () => {
  it("grant routes to the bucket implied by reason", async () => {
    await repo.grant({ userId: "u1", amount: 200, idempotencyKey: "b", reason: "signup_bonus" });
    await repo.grant({ userId: "u1", amount: 500, idempotencyKey: "p", reason: "purchase" });
    expect(await repo.getBreakdown("u1")).toEqual({ subscription: 0, bonus: 200, purchased: 500 });
    expect(await repo.getBalance("u1")).toBe(700);
  });

  it("resetSubscriptionCredits SETS the subscription bucket (no roll-over)", async () => {
    await repo.resetSubscriptionCredits({ userId: "u1", amount: 3000, idempotencyKey: "p1", reason: "subscription_grant" });
    expect((await repo.getBreakdown("u1")).subscription).toBe(3000);
    // A later period resets to the new amount; the old 3000 does NOT accumulate.
    await repo.resetSubscriptionCredits({ userId: "u1", amount: 3000, idempotencyKey: "p2", reason: "subscription_grant" });
    expect((await repo.getBreakdown("u1")).subscription).toBe(3000);
  });

  it("debit draws subscription first, then bonus, then purchased", async () => {
    await repo.resetSubscriptionCredits({ userId: "u1", amount: 100, idempotencyKey: "s", reason: "subscription_grant" });
    await repo.grant({ userId: "u1", amount: 100, idempotencyKey: "b", reason: "signup_bonus" });
    await repo.grant({ userId: "u1", amount: 100, idempotencyKey: "p", reason: "purchase" });
    // Spend 250: drains subscription(100) + bonus(100) + 50 of purchased.
    const r = await repo.debit({ userId: "u1", amount: 250, idempotencyKey: "d", reason: "consumption" });
    expect(r).toEqual({ ok: true, balanceAfter: 50, deduplicated: false });
    expect(await repo.getBreakdown("u1")).toEqual({ subscription: 0, bonus: 0, purchased: 50 });
  });
});

describe("subscription", () => {
  it("returns null when there is none", async () => {
    expect(await repo.getSubscription("u1")).toBeNull();
  });

  it("stores and reads back a subscription", async () => {
    const sub = {
      userId: "u1",
      tier: "pro" as const,
      status: "active" as const,
      interval: "monthly" as const,
      currentPeriodEnd: "2026-07-25T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    };
    await repo.setSubscription(sub);
    expect(await repo.getSubscription("u1")).toEqual(sub);
  });

  it("persists provider linkage ids on the subscription", async () => {
    await repo.setSubscription({
      userId: "u1",
      tier: "pro",
      status: "active",
      interval: "monthly",
      currentPeriodEnd: "2026-08-22T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      providerCustomerId: "cust_1",
      providerSubscriptionId: "sub_1",
    });
    const sub = await repo.getSubscription("u1");
    expect(sub?.providerCustomerId).toBe("cust_1");
    expect(sub?.providerSubscriptionId).toBe("sub_1");
  });
});
