import { describe, it, expect } from "vitest";
import { MemoryCreditRepository } from "../../src/credits/memory-credit-repository.js";
import { handleCreemEvent } from "../../src/billing/creem-webhook.js";
import { creemConfigFromEnv } from "../../src/billing/creem-config.js";

const catalog = creemConfigFromEnv({
  CREEM_API_KEY: "creem_test_k", CREEM_WEBHOOK_SECRET: "s",
  CREEM_PRODUCT_CREDITS: "prod_credits",
  CREEM_PRODUCT_PRO_MONTHLY: "prod_pm", CREEM_PRODUCT_PRO_YEARLY: "prod_py",
  CREEM_PRODUCT_MAX_MONTHLY: "prod_mm", CREEM_PRODUCT_MAX_YEARLY: "prod_my",
  CREEM_PRODUCT_ULTRA_MONTHLY: "prod_um", CREEM_PRODUCT_ULTRA_YEARLY: "prod_uy",
})!.products;

function deps() {
  const credits = new MemoryCreditRepository();
  return { credits, catalog };
}

const creditsCheckout = (amount: number) => ({
  id: "evt_1",
  eventType: "checkout.completed",
  object: {
    id: "ch_1",
    request_id: "co:u1:x",
    metadata: { userId: "u1", kind: "credits" },
    order: { id: "ord_1", amount, product: "prod_credits" },
    product: { id: "prod_credits" },
    customer: { id: "cust_1", email: "t@e.com" },
  },
});

const subCheckout = {
  id: "evt_2",
  eventType: "checkout.completed",
  object: {
    id: "ch_2",
    metadata: { userId: "u1", kind: "subscription" },
    order: { id: "ord_2", amount: 2000, product: "prod_pm" },
    product: { id: "prod_pm" },
    customer: { id: "cust_1", email: "t@e.com" },
    subscription: {
      id: "sub_1",
      current_period_start_date: "2026-07-22T00:00:00.000Z",
      current_period_end_date: "2026-08-22T00:00:00.000Z",
    },
  },
};

describe("handleCreemEvent: checkout.completed for credits", () => {
  it("grants exactly the cents paid, into the purchased bucket", async () => {
    const d = deps();
    await handleCreemEvent(d, creditsCheckout(1250));
    expect(await d.credits.getBalance("u1")).toBe(1250);
    expect((await d.credits.getBreakdown("u1")).purchased).toBe(1250);
  });

  it("is idempotent across webhook retries (same order id)", async () => {
    const d = deps();
    await handleCreemEvent(d, creditsCheckout(2000));
    await handleCreemEvent(d, creditsCheckout(2000));
    expect(await d.credits.getBalance("u1")).toBe(2000);
  });
});

describe("handleCreemEvent: checkout.completed for a plan", () => {
  it("activates the subscription with provider ids and grants the first month", async () => {
    const d = deps();
    await handleCreemEvent(d, subCheckout);
    const sub = await d.credits.getSubscription("u1");
    expect(sub).toMatchObject({
      tier: "pro", interval: "monthly", status: "active",
      providerCustomerId: "cust_1", providerSubscriptionId: "sub_1",
    });
    expect((await d.credits.getBreakdown("u1")).subscription).toBe(3000);
  });

  it("re-delivery does not change the outcome (SET semantics)", async () => {
    const d = deps();
    await handleCreemEvent(d, subCheckout);
    await handleCreemEvent(d, subCheckout);
    expect((await d.credits.getBreakdown("u1")).subscription).toBe(3000);
  });
});

describe("handleCreemEvent: subscription lifecycle", () => {
  const subEvent = (eventType: string, extra: Record<string, unknown> = {}) => ({
    id: `evt_${eventType}`,
    eventType,
    object: {
      id: "sub_1",
      product: "prod_pm",
      customer: "cust_1",
      metadata: { userId: "u1" },
      current_period_start_date: "2026-08-22T00:00:00.000Z",
      current_period_end_date: "2026-09-22T00:00:00.000Z",
      ...extra,
    },
  });

  it("paid: refreshes the subscription bucket keyed on the Creem period", async () => {
    const d = deps();
    await handleCreemEvent(d, subCheckout);
    await d.credits.debit({ userId: "u1", amount: 500, idempotencyKey: "spend1", reason: "consumption" });
    await handleCreemEvent(d, subEvent("subscription.paid"));
    expect((await d.credits.getBreakdown("u1")).subscription).toBe(3000); // SET back to the grant
    await handleCreemEvent(d, subEvent("subscription.paid")); // retry: same key, no change
    expect((await d.credits.getBreakdown("u1")).subscription).toBe(3000);
  });

  it("scheduled_cancel: flags cancelAtPeriodEnd, stays active", async () => {
    const d = deps();
    await handleCreemEvent(d, subCheckout);
    await handleCreemEvent(d, subEvent("subscription.scheduled_cancel"));
    expect(await d.credits.getSubscription("u1")).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
  });

  it("canceled: marks canceled and zeroes the subscription bucket", async () => {
    const d = deps();
    await handleCreemEvent(d, subCheckout);
    await handleCreemEvent(d, subEvent("subscription.canceled"));
    expect(await d.credits.getSubscription("u1")).toMatchObject({ status: "canceled" });
    expect((await d.credits.getBreakdown("u1")).subscription).toBe(0);
  });

  it("past_due: marks past_due, keeps the bucket", async () => {
    const d = deps();
    await handleCreemEvent(d, subCheckout);
    await handleCreemEvent(d, subEvent("subscription.past_due"));
    expect(await d.credits.getSubscription("u1")).toMatchObject({ status: "past_due" });
    expect((await d.credits.getBreakdown("u1")).subscription).toBe(3000);
  });
});

describe("handleCreemEvent: robustness", () => {
  it("ignores unknown event types, unknown products, and missing userId", async () => {
    const d = deps();
    await handleCreemEvent(d, { id: "e", eventType: "refund.created", object: { id: "ref_1" } });
    const noUser = creditsCheckout(1000);
    (noUser.object.metadata as Record<string, unknown>).userId = undefined;
    await handleCreemEvent(d, noUser);
    const badProduct = creditsCheckout(1000);
    badProduct.object.order.product = "prod_unknown";
    (badProduct.object.product as { id: string }).id = "prod_unknown";
    await handleCreemEvent(d, badProduct);
    await handleCreemEvent(d, "not even an object");
    expect(await d.credits.getBalance("u1")).toBe(0);
  });
});
