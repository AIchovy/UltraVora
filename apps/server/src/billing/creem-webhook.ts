// Applies Creem webhook events to the credit ledger/subscription. Pure of
// HTTP concerns — the route (creem-webhook-routes.ts) verifies the signature
// and JSON-parses before calling in. Idempotency: purchased-credit grants key
// on the Creem order id (ADD, must never replay); subscription grants are
// SETs, so replays and races with the lazy dueRefresh converge on the same
// value (design §4.4).
import { z } from "zod";
import { getPlan } from "@ultracreator/shared";
import type { CreditRepository } from "../credits/credit-repository.js";
import { activateSubscription } from "../credits/subscription.js";
import { identifyProduct, type CreemProductCatalog } from "./creem-config.js";

export interface CreemWebhookDeps {
  credits: CreditRepository;
  catalog: CreemProductCatalog;
  log?: (msg: string, data?: unknown) => void;
}

/** Creem sends `product`/`customer` as either a bare id or an expanded object. */
const IdRef = z.union([z.string(), z.object({ id: z.string() }).passthrough()]);
const idOf = (v: z.infer<typeof IdRef>): string => (typeof v === "string" ? v : v.id);

const Metadata = z.object({ userId: z.string().min(1) }).passthrough();

const Envelope = z
  .object({
    id: z.string(),
    eventType: z.string(),
    object: z.record(z.unknown()),
  })
  .passthrough();

const CheckoutObject = z
  .object({
    id: z.string(),
    metadata: Metadata,
    order: z
      .object({ id: z.string(), amount: z.number().int().positive(), product: IdRef })
      .passthrough(),
    product: IdRef,
    customer: IdRef,
    subscription: z.object({ id: z.string() }).passthrough().optional(),
  })
  .passthrough();

const SubscriptionObject = z
  .object({
    id: z.string(),
    product: IdRef,
    customer: IdRef,
    metadata: Metadata,
    current_period_start_date: z.string().optional(),
    current_period_end_date: z.string().optional(),
  })
  .passthrough();

export async function handleCreemEvent(deps: CreemWebhookDeps, event: unknown): Promise<void> {
  const log = deps.log ?? (() => {});
  const env = Envelope.safeParse(event);
  if (!env.success) {
    log("creem webhook: unparseable event", { issues: env.error.issues });
    return;
  }
  const { eventType, object } = env.data;

  switch (eventType) {
    case "checkout.completed":
      return handleCheckoutCompleted(deps, log, object);
    case "subscription.paid":
    case "subscription.scheduled_cancel":
    case "subscription.canceled":
    case "subscription.expired":
    case "subscription.past_due":
      return handleSubscriptionEvent(deps, log, env.data.id, eventType, object);
    default:
      log(`creem webhook: ignoring event type ${eventType}`);
  }
}

async function handleCheckoutCompleted(
  deps: CreemWebhookDeps,
  log: NonNullable<CreemWebhookDeps["log"]>,
  object: unknown,
): Promise<void> {
  const parsed = CheckoutObject.safeParse(object);
  if (!parsed.success) {
    log("creem webhook: checkout.completed missing fields", { issues: parsed.error.issues });
    return;
  }
  const co = parsed.data;
  const userId = co.metadata.userId;
  const identity = identifyProduct(deps.catalog, idOf(co.order.product));
  if (!identity) {
    log("creem webhook: unknown product on order", { product: idOf(co.order.product) });
    return;
  }

  if (identity.kind === "credits") {
    // 1 credit = 1 cent: whatever was actually paid is exactly what lands.
    await deps.credits.grant({
      userId,
      amount: co.order.amount,
      idempotencyKey: `creem:order:${co.order.id}`,
      reason: "purchase",
      ref: { provider: "creem", checkoutId: co.id, orderId: co.order.id, amountCents: co.order.amount },
    });
    return;
  }

  const { sub, grantKey, amount } = activateSubscription(userId, identity.tier, identity.interval, new Date());
  await deps.credits.setSubscription({
    ...sub,
    providerCustomerId: idOf(co.customer),
    providerSubscriptionId: co.subscription?.id ?? null,
  });
  await deps.credits.resetSubscriptionCredits({
    userId,
    amount,
    idempotencyKey: grantKey,
    reason: "subscription_grant",
    ref: { provider: "creem", checkoutId: co.id, tier: identity.tier, interval: identity.interval },
  });
}

async function handleSubscriptionEvent(
  deps: CreemWebhookDeps,
  log: NonNullable<CreemWebhookDeps["log"]>,
  eventId: string,
  eventType: string,
  object: unknown,
): Promise<void> {
  const parsed = SubscriptionObject.safeParse(object);
  if (!parsed.success) {
    log(`creem webhook: ${eventType} missing fields`, { issues: parsed.error.issues });
    return;
  }
  const ev = parsed.data;
  const userId = ev.metadata.userId;
  const existing = await deps.credits.getSubscription(userId);
  if (!existing) {
    log(`creem webhook: ${eventType} for user without a subscription`, { userId });
    return;
  }
  const linked = { ...existing, providerCustomerId: idOf(ev.customer), providerSubscriptionId: ev.id };

  switch (eventType) {
    case "subscription.paid":
      await deps.credits.setSubscription({ ...linked, status: "active" });
      await deps.credits.resetSubscriptionCredits({
        userId,
        amount: getPlan(existing.tier).monthlyCredits,
        idempotencyKey: `creem:subpaid:${ev.id}:${ev.current_period_start_date ?? "unknown"}`,
        reason: "subscription_grant",
        ref: { provider: "creem", subscriptionId: ev.id, periodStart: ev.current_period_start_date },
      });
      return;
    case "subscription.scheduled_cancel":
      await deps.credits.setSubscription({ ...linked, cancelAtPeriodEnd: true });
      return;
    case "subscription.canceled":
    case "subscription.expired":
      await deps.credits.setSubscription({ ...linked, status: "canceled" });
      // Subscription credits die with the subscription (bonus/purchased persist).
      await deps.credits.resetSubscriptionCredits({
        userId,
        amount: 0,
        idempotencyKey: `creem:subzero:${eventId}`,
        reason: "subscription_grant",
        ref: { provider: "creem", subscriptionId: ev.id, event: eventType },
      });
      return;
    case "subscription.past_due":
      await deps.credits.setSubscription({ ...linked, status: "past_due" });
      return;
  }
}
