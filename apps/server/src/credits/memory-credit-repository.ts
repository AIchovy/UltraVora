import type {
  CreditBreakdown,
  CreditRepository,
  DebitResult,
  GrantResult,
  LedgerInput,
  LedgerReason,
  SubscriptionRecord,
} from "./credit-repository.js";

type Bucket = keyof CreditBreakdown;

/**
 * In-memory CreditRepository for unit tests and non-PG dev. Mirrors the PG
 * impl's contract: bucketed balance (subscription/bonus/purchased), atomic
 * check-and-deduct with priority draw, idempotent grant/debit/reset by key.
 */
export class MemoryCreditRepository implements CreditRepository {
  private buckets = new Map<string, CreditBreakdown>();
  private subscriptions = new Map<string, SubscriptionRecord>();
  /** idempotencyKey → resulting total balanceAfter, so a replay returns the original. */
  private applied = new Map<string, number>();

  private bucketsOf(userId: string): CreditBreakdown {
    return this.buckets.get(userId) ?? { subscription: 0, bonus: 0, purchased: 0 };
  }

  async getBreakdown(userId: string): Promise<CreditBreakdown> {
    return { ...this.bucketsOf(userId) };
  }

  async getBalance(userId: string): Promise<number> {
    const b = this.bucketsOf(userId);
    return b.subscription + b.bonus + b.purchased;
  }

  async debit(input: LedgerInput): Promise<DebitResult> {
    this.assertPositive(input.amount);
    const prior = this.applied.get(input.idempotencyKey);
    if (prior !== undefined) return { ok: true, balanceAfter: prior, deduplicated: true };

    const b = { ...this.bucketsOf(input.userId) };
    const total = b.subscription + b.bonus + b.purchased;
    if (total < input.amount) {
      return { ok: false, reason: "insufficient", balance: total, needed: input.amount };
    }
    // Draw subscription → bonus → purchased (spend the expiring bucket first).
    let remaining = input.amount;
    for (const bucket of ["subscription", "bonus", "purchased"] as const) {
      const take = Math.min(remaining, b[bucket]);
      b[bucket] -= take;
      remaining -= take;
    }
    this.buckets.set(input.userId, b);
    const balanceAfter = b.subscription + b.bonus + b.purchased;
    this.applied.set(input.idempotencyKey, balanceAfter);
    return { ok: true, balanceAfter, deduplicated: false };
  }

  async grant(input: LedgerInput): Promise<GrantResult> {
    this.assertPositive(input.amount);
    const prior = this.applied.get(input.idempotencyKey);
    if (prior !== undefined) return { balanceAfter: prior, deduplicated: true };

    const b = { ...this.bucketsOf(input.userId) };
    b[bucketForReason(input.reason)] += input.amount;
    this.buckets.set(input.userId, b);
    const balanceAfter = b.subscription + b.bonus + b.purchased;
    this.applied.set(input.idempotencyKey, balanceAfter);
    return { balanceAfter, deduplicated: false };
  }

  async resetSubscriptionCredits(input: LedgerInput): Promise<GrantResult> {
    this.assertNonNegative(input.amount);
    const prior = this.applied.get(input.idempotencyKey);
    if (prior !== undefined) return { balanceAfter: prior, deduplicated: true };

    const b = { ...this.bucketsOf(input.userId) };
    b.subscription = input.amount; // SET, not add — expires any leftover.
    this.buckets.set(input.userId, b);
    const balanceAfter = b.subscription + b.bonus + b.purchased;
    this.applied.set(input.idempotencyKey, balanceAfter);
    return { balanceAfter, deduplicated: false };
  }

  async getSubscription(userId: string): Promise<SubscriptionRecord | null> {
    return this.subscriptions.get(userId) ?? null;
  }

  async setSubscription(sub: SubscriptionRecord): Promise<void> {
    this.subscriptions.set(sub.userId, { ...sub });
  }

  private assertPositive(amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(`credit amount must be a positive integer, got ${amount}`);
    }
  }

  private assertNonNegative(amount: number): void {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error(`credit amount must be a non-negative integer, got ${amount}`);
    }
  }
}

function bucketForReason(reason: LedgerReason): Bucket {
  switch (reason) {
    case "signup_bonus":
      return "bonus";
    case "subscription_grant":
      return "subscription";
    default:
      return "purchased"; // purchase, refund, adjustment, consumption(n/a here)
  }
}
