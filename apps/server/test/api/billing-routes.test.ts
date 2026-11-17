import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";
import { createApp, type AppDeps, type CreateAppOptions } from "../../src/api/app.js";
import { fakeAuthService } from "../helpers/fake-auth.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";
import { MemoryCreditRepository } from "../../src/credits/memory-credit-repository.js";
import { creemConfigFromEnv } from "../../src/billing/creem-config.js";
import type { CreemCheckoutInput, CreemClient } from "../../src/billing/creem-client.js";

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let eventLog: SessionEventLog;
let credits: MemoryCreditRepository;
let orchestrator: SessionOrchestrator;
let sessions: InMemorySessionRepository;

function makeApp(loggedIn: boolean, opts: CreateAppOptions = {}, extraDeps: Partial<AppDeps> = {}) {
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  sessions = new InMemorySessionRepository();
  credits = new MemoryCreditRepository();
  orchestrator = new SessionOrchestrator({
    workspaces,
    events,
    artifacts,
    phases: new PhaseRegistry(),
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(),
    sessions,
    messages: new InMemoryMessageStore(),
    credits,
  });
  eventLog = new SessionEventLog({ events, store: new InMemoryEventStore(), batchMs: 0 });
  const deps: AppDeps = {
    workspaces,
    events,
    artifacts,
    phases: new PhaseRegistry(),
    orchestrator,
    eventLog,
    auth: fakeAuthService(loggedIn ? undefined : null),
    sessions,
    credits,
    ...extraDeps,
  };
  return createApp(deps, opts);
}

const creemTestConfig = creemConfigFromEnv({
  CREEM_API_KEY: "creem_test_k", CREEM_WEBHOOK_SECRET: "whsec",
  CREEM_PRODUCT_CREDITS: "prod_credits",
  CREEM_PRODUCT_PRO_MONTHLY: "prod_pm", CREEM_PRODUCT_PRO_YEARLY: "prod_py",
  CREEM_PRODUCT_MAX_MONTHLY: "prod_mm", CREEM_PRODUCT_MAX_YEARLY: "prod_my",
  CREEM_PRODUCT_ULTRA_MONTHLY: "prod_um", CREEM_PRODUCT_ULTRA_YEARLY: "prod_uy",
})!;

function fakeCreemClient() {
  const calls: CreemCheckoutInput[] = [];
  const client: CreemClient = {
    createCheckout: async (input) => {
      calls.push(input);
      return { checkoutUrl: `https://creem.io/checkout/${input.productId}` };
    },
    createCustomerPortal: async (customerId) => ({ url: `https://creem.io/portal/${customerId}` }),
    moderatePrompt: async () => ({ decision: "allow" }),
  };
  return { client, calls };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-billing-route-"));
  // Stub-behavior tests opt in, mirroring BILLING_STUBS=1 in dev.
  app = await makeApp(true, { billingStubs: true });
});
afterEach(async () => {
  await app.close();
  await eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("billing routes", () => {
  it("GET /api/credits grants the 200 signup bonus once (to the bonus bucket)", async () => {
    const expected = {
      balance: 200,
      breakdown: { subscription: 0, bonus: 200, purchased: 0 },
      subscription: null,
      freePublicAvailable: true,
    };
    const r1 = await app.inject({ method: "GET", url: "/api/credits" });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual(expected);

    // Idempotent: a second read does not re-grant the bonus.
    const r2 = await app.inject({ method: "GET", url: "/api/credits" });
    expect(r2.json()).toEqual(expected);
  });

  it("POST /api/billing/grant adds credits by usd (×100) or raw credits", async () => {
    await app.inject({ method: "GET", url: "/api/credits" }); // bonus 200

    const byUsd = await app.inject({ method: "POST", url: "/api/billing/grant", payload: { usd: 20 } });
    expect(byUsd.statusCode).toBe(200);
    expect(byUsd.json()).toEqual({ balance: 2200 }); // 200 + 2000

    const byCredits = await app.inject({ method: "POST", url: "/api/billing/grant", payload: { credits: 500 } });
    expect(byCredits.json()).toEqual({ balance: 2700 });
  });

  it("POST /api/billing/grant rejects an empty body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/billing/grant", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/billing/subscribe activates the tier and grants the first month's credits", async () => {
    const res = await app.inject({ method: "POST", url: "/api/billing/subscribe", payload: { tier: "pro", interval: "monthly" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { balance: number; subscription: { tier: string; status: string; interval: string } };
    expect(body.balance).toBe(3000); // Pro monthly grant
    expect(body.subscription).toMatchObject({ tier: "pro", status: "active", interval: "monthly" });

    // GET reflects the active subscription (and doesn't refresh before the period ends).
    const credits = await app.inject({ method: "GET", url: "/api/credits" });
    const c = credits.json() as {
      balance: number;
      breakdown: { subscription: number; bonus: number; purchased: number };
      subscription: { tier: string } | null;
    };
    expect(c.subscription?.tier).toBe("pro");
    expect(c.balance).toBe(3200); // 3000 subscription + 200 signup bonus granted on this GET
    expect(c.breakdown).toEqual({ subscription: 3000, bonus: 200, purchased: 0 });
  });

  it("POST /api/billing/subscribe rejects an invalid tier", async () => {
    const res = await app.inject({ method: "POST", url: "/api/billing/subscribe", payload: { tier: "free", interval: "monthly" } });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/sessions/:sid/resume is a 202 no-op for a non-parked session", async () => {
    const created = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = created.json() as { sessionId: string };
    const res = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/resume` });
    expect(res.statusCode).toBe(202);
  });

  it("POST /api/billing/grant does NOT auto-resume a parked session", async () => {
    // A session parked for credits, owned by the authed test user.
    await sessions.create({ id: "parked1", userId: "u-test" });
    await sessions.updateStatus("parked1", {
      status: "awaiting-credits",
      currentPhase: "research",
      error: null,
    });
    const resumeSpy = vi.spyOn(orchestrator, "resumeCredits");

    const res = await app.inject({
      method: "POST",
      url: "/api/billing/grant",
      payload: { credits: 100 },
    });

    expect(res.statusCode).toBe(200);
    expect(resumeSpy).not.toHaveBeenCalled();
    // The session stays parked; only an explicit /resume continues it.
    expect((await sessions.get("parked1"))?.status).toBe("awaiting-credits");
  });

  it("reports freePublicAvailable=true before any grant, false after", async () => {
    const before = await app.inject({ method: "GET", url: "/api/credits" });
    expect((before.json() as { freePublicAvailable: boolean }).freePublicAvailable).toBe(true);

    // Consume the grant on a public session.
    await sessions.create({ id: "pub", userId: "u-test", isPublic: true });
    await sessions.claimFreePublicGrant("pub", "u-test");

    const after = await app.inject({ method: "GET", url: "/api/credits" });
    expect((after.json() as { freePublicAvailable: boolean }).freePublicAvailable).toBe(false);
  });

  it("returns 404 for grant and subscribe when stubs are disabled (default)", async () => {
    await app.close();
    await eventLog.closeAll();
    app = await makeApp(true); // no billingStubs opt — production default
    const grant = await app.inject({ method: "POST", url: "/api/billing/grant", payload: { usd: 20 } });
    expect(grant.statusCode).toBe(404);
    const subscribe = await app.inject({
      method: "POST",
      url: "/api/billing/subscribe",
      payload: { tier: "pro", interval: "monthly" },
    });
    expect(subscribe.statusCode).toBe(404);
  });

  it("keeps GET /api/credits available when stubs are disabled", async () => {
    await app.close();
    await eventLog.closeAll();
    app = await makeApp(true); // no billingStubs opt — production default
    const res = await app.inject({ method: "GET", url: "/api/credits" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { balance: number }).balance).toBe(200);
  });

  it("requires auth", async () => {
    await app.close();
    await eventLog.closeAll();
    app = await makeApp(false, { billingStubs: true });
    expect((await app.inject({ method: "GET", url: "/api/credits" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/billing/grant", payload: { usd: 20 } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/billing/subscribe", payload: { tier: "pro", interval: "monthly" } })).statusCode).toBe(401);
  });
});

describe("POST /api/billing/checkout (Creem configured)", () => {
  let calls: CreemCheckoutInput[];
  beforeEach(async () => {
    await app.close();
    await eventLog.closeAll();
    const fake = fakeCreemClient();
    calls = fake.calls;
    app = await makeApp(true, { webOrigin: "http://web.test" }, { creem: { config: creemTestConfig, client: fake.client } });
  });

  it("maps a subscription intent to the right product and returns the checkout URL", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/billing/checkout",
      payload: { kind: "subscription", tier: "max", interval: "yearly" },
    });
    expect(res.statusCode).toBe(200);
    // ?locale=en works around Creem's broken zh checkout translations.
    expect(res.json()).toEqual({ url: "https://creem.io/checkout/prod_my?locale=en" });
    expect(calls[0]).toMatchObject({
      productId: "prod_my",
      customerEmail: "test@example.com",
      successUrl: "http://web.test/billing/success?kind=subscription&tier=max",
      metadata: { userId: "u-test", kind: "subscription", tier: "max", interval: "yearly" },
    });
    expect(calls[0]?.customPriceCents).toBeUndefined();
  });

  it("maps a credits intent with custom_price cents and the credits success URL", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/billing/checkout",
      payload: { kind: "credits", usd: 12.5 },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({
      productId: "prod_credits",
      customPriceCents: 1250,
      successUrl: "http://web.test/billing/success?kind=credits&credits=1250",
      metadata: { userId: "u-test", kind: "credits", usd: 12.5 },
    });
  });

  it("validates the body (bounds, tier, kind)", async () => {
    for (const payload of [
      { kind: "credits", usd: 4 },
      { kind: "credits", usd: 1001 },
      { kind: "subscription", tier: "free", interval: "monthly" },
      { kind: "nope" },
      {},
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/billing/checkout", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("409s a subscription intent when a provider-linked subscription is active", async () => {
    await credits.setSubscription({
      userId: "u-test", tier: "pro", status: "active", interval: "monthly",
      currentPeriodEnd: null, cancelAtPeriodEnd: false,
      providerCustomerId: "cust_1", providerSubscriptionId: "sub_1",
    });
    const res = await app.inject({
      method: "POST", url: "/api/billing/checkout",
      payload: { kind: "subscription", tier: "max", interval: "monthly" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "existing_subscription" });
    // Credits top-ups stay allowed.
    const topUp = await app.inject({
      method: "POST", url: "/api/billing/checkout", payload: { kind: "credits", usd: 20 },
    });
    expect(topUp.statusCode).toBe(200);
  });
});

describe("POST /api/billing/checkout (stub fallback, no Creem)", () => {
  it("applies the stub effects directly and returns a balance instead of a url", async () => {
    // `app` from the outer beforeEach: billingStubs on, no creem dep.
    const credits20 = await app.inject({
      method: "POST", url: "/api/billing/checkout", payload: { kind: "credits", usd: 20 },
    });
    expect(credits20.statusCode).toBe(200);
    expect(credits20.json()).toEqual({ balance: 2000 });

    const sub = await app.inject({
      method: "POST", url: "/api/billing/checkout",
      payload: { kind: "subscription", tier: "pro", interval: "monthly" },
    });
    expect(sub.json()).toEqual({ balance: 5000 }); // 2000 + 3000 sub grant
  });

  it("404s when neither Creem nor stubs are enabled", async () => {
    await app.close();
    await eventLog.closeAll();
    app = await makeApp(true);
    const res = await app.inject({
      method: "POST", url: "/api/billing/checkout", payload: { kind: "credits", usd: 20 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/billing/portal", () => {
  it("returns the portal URL for a provider-linked subscription, 404 otherwise", async () => {
    await app.close();
    await eventLog.closeAll();
    const fake = fakeCreemClient();
    app = await makeApp(true, {}, { creem: { config: creemTestConfig, client: fake.client } });

    const none = await app.inject({ method: "POST", url: "/api/billing/portal" });
    expect(none.statusCode).toBe(404);

    await credits.setSubscription({
      userId: "u-test", tier: "pro", status: "active", interval: "monthly",
      currentPeriodEnd: null, cancelAtPeriodEnd: false,
      providerCustomerId: "cust_9", providerSubscriptionId: "sub_9",
    });
    const res = await app.inject({ method: "POST", url: "/api/billing/portal" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://creem.io/portal/cust_9" });
  });
});
