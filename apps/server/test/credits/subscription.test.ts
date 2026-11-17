import { describe, it, expect } from "vitest";
import {
  nextPeriodEnd,
  activateSubscription,
  dueRefresh,
} from "../../src/credits/subscription.js";
import type { SubscriptionRecord } from "../../src/credits/credit-repository.js";

const now = new Date("2026-06-26T00:00:00.000Z");

describe("subscription period math", () => {
  it("nextPeriodEnd adds a month or a year (UTC)", () => {
    expect(nextPeriodEnd(now, "monthly").toISOString()).toBe("2026-07-26T00:00:00.000Z");
    expect(nextPeriodEnd(now, "yearly").toISOString()).toBe("2027-06-26T00:00:00.000Z");
  });
});

describe("activateSubscription", () => {
  it("returns an active sub + the first period's grant", () => {
    const r = activateSubscription("u1", "pro", "monthly", now);
    expect(r.sub).toEqual({
      userId: "u1",
      tier: "pro",
      status: "active",
      interval: "monthly",
      currentPeriodEnd: "2026-07-26T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    });
    expect(r.amount).toBe(3000);
    expect(r.grantKey).toBe("sub:u1:2026-07-26T00:00:00.000Z");
  });
});

describe("dueRefresh", () => {
  const sub = activateSubscription("u1", "pro", "monthly", now).sub; // ends 2026-07-26

  it("is null before the period ends", () => {
    expect(dueRefresh(sub, new Date("2026-07-01T00:00:00.000Z"))).toBeNull();
  });

  it("rolls the period forward and grants once the period elapses", () => {
    const r = dueRefresh(sub, new Date("2026-07-26T00:00:00.000Z"));
    expect(r).not.toBeNull();
    expect(r!.sub.currentPeriodEnd).toBe("2026-08-26T00:00:00.000Z");
    expect(r!.amount).toBe(3000);
    expect(r!.grantKey).toBe("sub:u1:2026-08-26T00:00:00.000Z");
  });

  it("is null for a non-active subscription", () => {
    const canceled: SubscriptionRecord = { ...sub, status: "canceled" };
    expect(dueRefresh(canceled, new Date("2027-01-01T00:00:00.000Z"))).toBeNull();
  });
});

describe("yearly billing still refreshes credits monthly", () => {
  it("activateSubscription(yearly) sets a one-MONTH refresh boundary", () => {
    const r = activateSubscription("u1", "pro", "yearly", now); // now = 2026-06-26
    expect(r.sub.interval).toBe("yearly");
    expect(r.sub.currentPeriodEnd).toBe("2026-07-26T00:00:00.000Z");
    expect(r.amount).toBe(3000);
  });

  it("dueRefresh on a yearly sub rolls forward one month", () => {
    const sub = activateSubscription("u1", "pro", "yearly", now).sub;
    const r = dueRefresh(sub, new Date("2026-07-26T00:00:00.000Z"));
    expect(r!.sub.currentPeriodEnd).toBe("2026-08-26T00:00:00.000Z");
  });
});
