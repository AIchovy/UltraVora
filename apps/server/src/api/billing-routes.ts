import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CREDITS_PER_USD, CUSTOM_CREDIT_BOUNDS, creditsForUsd, getPlan } from "@ultracreator/shared";
import type { AppDeps } from "./app.js";
import type { CreemCheckoutInput } from "../billing/creem-client.js";
import { activateSubscription, dueRefresh } from "../credits/subscription.js";

/** Idempotency key for the one-time Free signup bonus. */
const signupBonusKey = (userId: string): string => `signup:${userId}`;

/**
 * Credits + billing endpoints. Auth is enforced by createSessionGuard (which
 * also protects /api/credits and /api/billing/*). The plan/pack catalog is
 * static shared data (`@ultracreator/shared`) consumed directly by the web app,
 * so there is no /plans endpoint here.
 *
 * Purchases: /checkout creates a Creem checkout (the browser redirects to the
 * returned URL) and /portal opens Creem's customer portal for cancel/plan
 * changes; the money→credits effects land via the signed webhook
 * (creem-webhook-routes.ts). Without Creem env config, /checkout falls back to
 * the dev stub behavior when `stubs` is set (BILLING_STUBS=1) — applying the
 * effects directly and returning a balance instead of a URL — and otherwise
 * doesn't exist (404). The legacy /grant + /subscribe stubs stay dev-only.
 */
export async function registerBillingRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  opts: { stubs?: boolean; webOrigin?: string } = {},
): Promise<void> {
  const credits = deps.credits;

  // Balance + subscription for the current user. Lazily grants the Free signup
  // bonus (idempotent) and rolls the subscription's monthly credit refresh
  // forward when the billing period has elapsed.
  app.get("/api/credits", async (req, reply) => {
    const userId = req.authUser?.id;
    if (!userId) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const freePublicAvailable = !(await deps.sessions.hasFreePublicGrant(userId));
    if (!credits) {
      reply.send({ balance: 0, subscription: null, freePublicAvailable });
      return;
    }
    const bonus = getPlan("free").signupBonus;
    if (bonus > 0) {
      await credits.grant({
        userId,
        amount: bonus,
        idempotencyKey: signupBonusKey(userId),
        reason: "signup_bonus",
      });
    }
    let subscription = await credits.getSubscription(userId);
    if (subscription) {
      const due = dueRefresh(subscription, new Date());
      if (due) {
        await credits.setSubscription(due.sub);
        // Refresh RESETS the subscription bucket (unused credits expire).
        await credits.resetSubscriptionCredits({
          userId,
          amount: due.amount,
          idempotencyKey: due.grantKey,
          reason: "subscription_grant",
          ref: { tier: due.sub.tier },
        });
        subscription = due.sub;
      }
    }
    const [balance, breakdown] = await Promise.all([
      credits.getBalance(userId),
      credits.getBreakdown(userId),
    ]);
    reply.send({ balance, breakdown, subscription, freePublicAvailable });
  });

  const creem = deps.creem;
  const webOrigin = (opts.webOrigin ?? "http://localhost:3000").replace(/\/$/, "");

  const CheckoutBody = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("credits"),
      usd: z.number().min(CUSTOM_CREDIT_BOUNDS.minUsd).max(CUSTOM_CREDIT_BOUNDS.maxUsd),
    }),
    z.object({
      kind: z.literal("subscription"),
      tier: z.enum(["pro", "max", "ultra"]),
      interval: z.enum(["monthly", "yearly"]),
    }),
  ]);

  if (creem || opts.stubs) {
    app.post("/api/billing/checkout", async (req, reply) => {
      const userId = req.authUser?.id;
      if (!userId) {
        reply.code(401).send({ error: "unauthorized" });
        return;
      }
      if (!credits) {
        reply.code(503).send({ error: "credits_disabled" });
        return;
      }
      const parsed = CheckoutBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid body" });
        return;
      }
      const intent = parsed.data;

      if (!creem) {
        // Dev stub fallback: apply the effects directly (BILLING_STUBS=1).
        if (intent.kind === "credits") {
          const amount = creditsForUsd(intent.usd);
          const result = await credits.grant({
            userId,
            amount,
            idempotencyKey: `dev-grant:${userId}:${Date.now()}:${amount}`,
            reason: "purchase",
            ref: { dev: true },
          });
          reply.send({ balance: result.balanceAfter });
          return;
        }
        const { sub, grantKey, amount } = activateSubscription(userId, intent.tier, intent.interval, new Date());
        await credits.setSubscription(sub);
        await credits.resetSubscriptionCredits({
          userId,
          amount,
          idempotencyKey: grantKey,
          reason: "subscription_grant",
          ref: { tier: intent.tier, interval: intent.interval },
        });
        reply.send({ balance: await credits.getBalance(userId) });
        return;
      }

      if (intent.kind === "subscription") {
        // Plan changes go through the Creem customer portal — a second live
        // subscription would double-bill.
        const existing = await credits.getSubscription(userId);
        if (existing && existing.status !== "canceled" && existing.providerSubscriptionId) {
          reply.code(409).send({ error: "existing_subscription" });
          return;
        }
      }

      const requestId = `co:${userId}:${randomUUID()}`;
      const email = req.authUser?.email;
      const input: CreemCheckoutInput =
        intent.kind === "credits"
          ? {
              productId: creem.config.products.credits,
              requestId,
              successUrl: `${webOrigin}/billing/success?kind=credits&credits=${creditsForUsd(intent.usd)}`,
              metadata: { userId, kind: "credits", usd: intent.usd },
              customPriceCents: Math.round(intent.usd * 100),
              ...(email ? { customerEmail: email } : {}),
            }
          : {
              productId: creem.config.products.plans[intent.tier][intent.interval],
              requestId,
              successUrl: `${webOrigin}/billing/success?kind=subscription&tier=${intent.tier}`,
              metadata: { userId, kind: "subscription", tier: intent.tier, interval: intent.interval },
              ...(email ? { customerEmail: email } : {}),
            };
      const { checkoutUrl } = await creem.client.createCheckout(input);
      // Force the checkout page to English: Creem's zh locale is missing the
      // checkout.stateProvince message, and rendering it (any billing country
      // with a state/province field) crashes the page mid-payment. Verified
      // 2026-07-22 in test mode; drop this once Creem fixes their zh bundle.
      const sep = checkoutUrl.includes("?") ? "&" : "?";
      reply.send({ url: `${checkoutUrl}${sep}locale=en` });
    });
  }

  if (creem) {
    app.post("/api/billing/portal", async (req, reply) => {
      const userId = req.authUser?.id;
      if (!userId) {
        reply.code(401).send({ error: "unauthorized" });
        return;
      }
      if (!credits) {
        reply.code(503).send({ error: "credits_disabled" });
        return;
      }
      const sub = await credits.getSubscription(userId);
      if (!sub?.providerCustomerId) {
        reply.code(404).send({ error: "no_portal" });
        return;
      }
      const { url } = await creem.client.createCustomerPortal(sub.providerCustomerId);
      reply.send({ url });
    });
  }

  // Without the opt-in, the payment stubs below simply don't exist (404).
  if (!opts.stubs) return;

  // DEV purchase stub: grant credits. The user resumes any parked session manually.
  const GrantBody = z
    .object({
      usd: z.number().positive().max(CUSTOM_CREDIT_BOUNDS.maxUsd).optional(),
      credits: z.number().int().positive().optional(),
    })
    .refine((b) => b.usd !== undefined || b.credits !== undefined, {
      message: "usd or credits required",
    });

  app.post("/api/billing/grant", async (req, reply) => {
    const userId = req.authUser?.id;
    if (!userId) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (!credits) {
      reply.code(503).send({ error: "credits_disabled" });
      return;
    }
    const parsed = GrantBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid body" });
      return;
    }
    const amount =
      parsed.data.credits ?? Math.round((parsed.data.usd as number) * CREDITS_PER_USD);
    const key = `dev-grant:${userId}:${Date.now()}:${amount}`;
    const result = await credits.grant({
      userId,
      amount,
      idempotencyKey: key,
      reason: "purchase",
      ref: { dev: true },
    });
    reply.send({ balance: result.balanceAfter });
  });

  // DEV subscription stub: activate the tier + grant the first period's credits.
  // Monthly refresh happens lazily in GET /api/credits. Parked runs resume manually.
  const SubscribeBody = z.object({
    tier: z.enum(["pro", "max", "ultra"]),
    interval: z.enum(["monthly", "yearly"]),
  });

  app.post("/api/billing/subscribe", async (req, reply) => {
    const userId = req.authUser?.id;
    if (!userId) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (!credits) {
      reply.code(503).send({ error: "credits_disabled" });
      return;
    }
    const parsed = SubscribeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid body" });
      return;
    }
    const { tier, interval } = parsed.data;
    const { sub, grantKey, amount } = activateSubscription(userId, tier, interval, new Date());
    await credits.setSubscription(sub);
    // Activation SETS the subscription bucket to the first period's grant.
    await credits.resetSubscriptionCredits({
      userId,
      amount,
      idempotencyKey: grantKey,
      reason: "subscription_grant",
      ref: { tier, interval },
    });
    const balance = await credits.getBalance(userId);
    reply.send({ balance, subscription: sub });
  });
}
