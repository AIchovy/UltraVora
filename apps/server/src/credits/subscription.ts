import { getPlan, type PlanTier } from "@ultracreator/shared";
import type { SubscriptionRecord } from "./credit-repository.js";

export type BillingInterval = "monthly" | "yearly";

/** The end of the next billing period after `start` (UTC, deterministic ISO). */
export function nextPeriodEnd(start: Date, interval: BillingInterval): Date {
  const d = new Date(start.getTime());
  if (interval === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export interface SubGrant {
  sub: SubscriptionRecord;
  /** Idempotency key for this period's credit grant (one grant per period end). */
  grantKey: string;
  amount: number;
}

/**
 * Activate `tier` for `userId` and describe the first period's credit grant.
 *
 * currentPeriodEnd is the CREDIT-REFRESH boundary, not the billing term:
 * yearly plans bill once a year but refresh credits monthly (pricing spec
 * decision 3). Billing-term boundaries live with the payment provider and
 * arrive via webhooks.
 */
export function activateSubscription(
  userId: string,
  tier: PlanTier,
  interval: BillingInterval,
  now: Date,
): SubGrant {
  const sub: SubscriptionRecord = {
    userId,
    tier,
    status: "active",
    interval,
    currentPeriodEnd: nextPeriodEnd(now, "monthly").toISOString(),
    cancelAtPeriodEnd: false,
  };
  return { sub, grantKey: `sub:${userId}:${sub.currentPeriodEnd}`, amount: getPlan(tier).monthlyCredits };
}

/**
 * If `now` is at/after the current period end of an active subscription, roll it
 * forward one period and describe that period's credit grant. Otherwise null.
 * The grant key is unique per period end, so applying it is idempotent.
 */
export function dueRefresh(sub: SubscriptionRecord, now: Date): SubGrant | null {
  if (sub.status !== "active" || !sub.currentPeriodEnd) return null;
  if (now.getTime() < new Date(sub.currentPeriodEnd).getTime()) return null;
  // Monthly step regardless of billing interval — see activateSubscription.
  const end = nextPeriodEnd(new Date(sub.currentPeriodEnd), "monthly").toISOString();
  const next: SubscriptionRecord = { ...sub, currentPeriodEnd: end };
  return { sub: next, grantKey: `sub:${sub.userId}:${end}`, amount: getPlan(sub.tier).monthlyCredits };
}
