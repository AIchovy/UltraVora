import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { creditBalance, creditLedger, subscription } from "../db/schema/billing.js";
import type {
  CreditBreakdown,
  CreditRepository,
  DebitResult,
  GrantResult,
  LedgerInput,
  LedgerReason,
  SubscriptionRecord,
} from "./credit-repository.js";

// drizzle's transaction handle — same surface as Db for our purposes.
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const total = (b: CreditBreakdown): number => b.subscription + b.bonus + b.purchased;

export class PgCreditRepository implements CreditRepository {
  constructor(private db: Db) {}

  async getBalance(userId: string): Promise<number> {
    const rows = await this.db
      .select({ balance: creditBalance.balance })
      .from(creditBalance)
      .where(eq(creditBalance.userId, userId));
    return rows[0]?.balance ?? 0;
  }

  async getBreakdown(userId: string): Promise<CreditBreakdown> {
    const rows = await this.db
      .select({
        subscription: creditBalance.subscriptionCredits,
        bonus: creditBalance.bonusCredits,
        purchased: creditBalance.purchasedCredits,
      })
      .from(creditBalance)
      .where(eq(creditBalance.userId, userId));
    const r = rows[0];
    return { subscription: r?.subscription ?? 0, bonus: r?.bonus ?? 0, purchased: r?.purchased ?? 0 };
  }

  async debit(input: LedgerInput): Promise<DebitResult> {
    assertPositive(input.amount);
    return this.db.transaction(async (tx) => {
      const b = await lockBuckets(tx, input.userId);
      const prior = await findByKey(tx, input.idempotencyKey);
      if (prior !== undefined) return { ok: true, balanceAfter: prior, deduplicated: true };
      if (total(b) < input.amount) {
        return { ok: false, reason: "insufficient", balance: total(b), needed: input.amount };
      }
      // Draw subscription → bonus → purchased (spend the expiring bucket first).
      const next = { ...b };
      let remaining = input.amount;
      for (const bucket of ["subscription", "bonus", "purchased"] as const) {
        const take = Math.min(remaining, next[bucket]);
        next[bucket] -= take;
        remaining -= take;
      }
      await writeEntry(tx, input, -input.amount, next);
      return { ok: true, balanceAfter: total(next), deduplicated: false };
    });
  }

  async grant(input: LedgerInput): Promise<GrantResult> {
    assertPositive(input.amount);
    return this.db.transaction(async (tx) => {
      const b = await lockBuckets(tx, input.userId);
      const prior = await findByKey(tx, input.idempotencyKey);
      if (prior !== undefined) return { balanceAfter: prior, deduplicated: true };
      const next = { ...b };
      next[bucketForReason(input.reason)] += input.amount;
      await writeEntry(tx, input, input.amount, next);
      return { balanceAfter: total(next), deduplicated: false };
    });
  }

  async resetSubscriptionCredits(input: LedgerInput): Promise<GrantResult> {
    assertNonNegative(input.amount);
    return this.db.transaction(async (tx) => {
      const b = await lockBuckets(tx, input.userId);
      const prior = await findByKey(tx, input.idempotencyKey);
      if (prior !== undefined) return { balanceAfter: prior, deduplicated: true };
      const next = { ...b, subscription: input.amount }; // SET — expires any leftover.
      await writeEntry(tx, { ...input, reason: "subscription_grant" }, input.amount - b.subscription, next);
      return { balanceAfter: total(next), deduplicated: false };
    });
  }

  async getSubscription(userId: string): Promise<SubscriptionRecord | null> {
    const rows = await this.db.select().from(subscription).where(eq(subscription.userId, userId));
    const r = rows[0];
    if (!r) return null;
    return {
      userId: r.userId,
      tier: r.tier as SubscriptionRecord["tier"],
      status: r.status as SubscriptionRecord["status"],
      interval: r.interval as SubscriptionRecord["interval"],
      currentPeriodEnd: r.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: r.cancelAtPeriodEnd,
      providerCustomerId: r.providerCustomerId ?? null,
      providerSubscriptionId: r.providerSubscriptionId ?? null,
    };
  }

  async setSubscription(sub: SubscriptionRecord): Promise<void> {
    const values = {
      userId: sub.userId,
      tier: sub.tier,
      status: sub.status,
      interval: sub.interval,
      currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      providerCustomerId: sub.providerCustomerId ?? null,
      providerSubscriptionId: sub.providerSubscriptionId ?? null,
      updatedAt: new Date(),
    };
    await this.db
      .insert(subscription)
      .values(values)
      .onConflictDoUpdate({ target: subscription.userId, set: values });
  }
}

/** Ensure the balance row exists, then lock it FOR UPDATE and return the buckets. */
async function lockBuckets(tx: Tx, userId: string): Promise<CreditBreakdown> {
  await tx.insert(creditBalance).values({ userId, balance: 0 }).onConflictDoNothing();
  const rows = await tx
    .select({
      subscription: creditBalance.subscriptionCredits,
      bonus: creditBalance.bonusCredits,
      purchased: creditBalance.purchasedCredits,
    })
    .from(creditBalance)
    .where(eq(creditBalance.userId, userId))
    .for("update");
  const r = rows[0];
  return { subscription: r?.subscription ?? 0, bonus: r?.bonus ?? 0, purchased: r?.purchased ?? 0 };
}

/** The total balanceAfter recorded for an already-applied idempotency key, if any. */
async function findByKey(tx: Tx, idempotencyKey: string): Promise<number | undefined> {
  const rows = await tx
    .select({ balanceAfter: creditLedger.balanceAfter })
    .from(creditLedger)
    .where(eq(creditLedger.idempotencyKey, idempotencyKey))
    .limit(1);
  return rows[0]?.balanceAfter;
}

async function writeEntry(tx: Tx, input: LedgerInput, delta: number, next: CreditBreakdown): Promise<void> {
  const balanceAfter = total(next);
  await tx.insert(creditLedger).values({
    userId: input.userId,
    delta,
    reason: input.reason,
    ref: input.ref ?? null,
    idempotencyKey: input.idempotencyKey,
    balanceAfter,
  });
  await tx
    .update(creditBalance)
    .set({
      balance: balanceAfter,
      subscriptionCredits: next.subscription,
      bonusCredits: next.bonus,
      purchasedCredits: next.purchased,
      updatedAt: new Date(),
    })
    .where(eq(creditBalance.userId, input.userId));
}

function bucketForReason(reason: LedgerReason): keyof CreditBreakdown {
  switch (reason) {
    case "signup_bonus":
      return "bonus";
    case "subscription_grant":
      return "subscription";
    default:
      return "purchased";
  }
}

function assertPositive(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`credit amount must be a positive integer, got ${amount}`);
  }
}

function assertNonNegative(amount: number): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`credit amount must be a non-negative integer, got ${amount}`);
  }
}
