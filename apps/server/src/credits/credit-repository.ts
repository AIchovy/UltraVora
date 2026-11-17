import type { PlanTier } from "@ultracreator/shared";

/** Why a ledger entry exists. Positive deltas: grants/purchases; negative: consumption. */
export type LedgerReason =
  | "signup_bonus"
  | "subscription_grant"
  | "purchase"
  | "consumption"
  | "refund"
  | "adjustment";

export interface DebitOk {
  ok: true;
  balanceAfter: number;
  /** True when this idempotencyKey was already applied — no new charge happened. */
  deduplicated: boolean;
}
export interface DebitInsufficient {
  ok: false;
  reason: "insufficient";
  balance: number;
  needed: number;
}
export type DebitResult = DebitOk | DebitInsufficient;

export interface GrantResult {
  balanceAfter: number;
  deduplicated: boolean;
}

/**
 * Balance split by source. Subscription credits reset each billing period (do
 * not roll over); bonus (signup) and purchased credits persist. Total balance =
 * subscription + bonus + purchased.
 */
export interface CreditBreakdown {
  subscription: number;
  bonus: number;
  purchased: number;
}

export interface SubscriptionRecord {
  userId: string;
  tier: PlanTier;
  status: "active" | "canceled" | "past_due";
  interval: "monthly" | "yearly";
  currentPeriodEnd: string | null; // ISO
  cancelAtPeriodEnd: boolean;
  /** Payment-provider linkage (Creem); absent for stub-activated subs. */
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
}

export interface LedgerInput {
  userId: string;
  amount: number; // positive integer
  idempotencyKey: string;
  reason: LedgerReason;
  /** Free-form provenance (session/phase/op, purchase/sub id). */
  ref?: unknown;
}

/**
 * Persistence for a user's credit balance, the append-only ledger behind it, and
 * their subscription. The PG impl and the in-memory fake MUST behave identically
 * (same contract as SessionRepository's pair).
 *
 * `debit` is the load-bearing primitive for mid-task gating: it is atomic
 * (check-and-deduct in one step, no overdraw under concurrency) and idempotent
 * on `idempotencyKey` (a resumed run re-running an already-paid op does not
 * double-charge).
 */
export interface CreditRepository {
  /** Total balance across all buckets. */
  getBalance(userId: string): Promise<number>;
  /** Balance split by source (subscription / bonus / purchased). */
  getBreakdown(userId: string): Promise<CreditBreakdown>;
  /**
   * Atomically deduct `amount` if the total balance covers it; otherwise return
   * `insufficient` without mutating. Draws from buckets in priority order
   * subscription → bonus → purchased (spend the expiring bucket first).
   * Idempotent: a repeat of the same idempotencyKey returns the original
   * outcome with `deduplicated: true`.
   */
  debit(input: LedgerInput): Promise<DebitResult>;
  /**
   * Add `amount` credits to the bucket implied by `reason`: signup_bonus → bonus,
   * purchase/refund/adjustment → purchased, subscription_grant → subscription
   * (additive). Idempotent on idempotencyKey. For the monthly subscription
   * reset use `resetSubscriptionCredits` instead (it sets, not adds).
   */
  grant(input: LedgerInput): Promise<GrantResult>;
  /**
   * SET the subscription bucket to `amount` (the per-period refresh — unused
   * subscription credits are expired, not carried over). Idempotent per
   * idempotencyKey (one reset per billing period). Bonus/purchased untouched.
   */
  resetSubscriptionCredits(input: LedgerInput): Promise<GrantResult>;
  getSubscription(userId: string): Promise<SubscriptionRecord | null>;
  setSubscription(sub: SubscriptionRecord): Promise<void>;
}
