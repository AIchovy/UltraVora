import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";
import { createApp, type AppDeps } from "../../src/api/app.js";
import { fakeAuthService } from "../helpers/fake-auth.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";
import { MemoryCreditRepository } from "../../src/credits/memory-credit-repository.js";
import { creemConfigFromEnv } from "../../src/billing/creem-config.js";
import type { CreemClient } from "../../src/billing/creem-client.js";

const SECRET = "whsec_route_test";
const config = creemConfigFromEnv({
  CREEM_API_KEY: "creem_test_k", CREEM_WEBHOOK_SECRET: SECRET,
  CREEM_PRODUCT_CREDITS: "prod_credits",
  CREEM_PRODUCT_PRO_MONTHLY: "prod_pm", CREEM_PRODUCT_PRO_YEARLY: "prod_py",
  CREEM_PRODUCT_MAX_MONTHLY: "prod_mm", CREEM_PRODUCT_MAX_YEARLY: "prod_my",
  CREEM_PRODUCT_ULTRA_MONTHLY: "prod_um", CREEM_PRODUCT_ULTRA_YEARLY: "prod_uy",
})!;

const fakeClient: CreemClient = {
  createCheckout: async () => ({ checkoutUrl: "https://creem.io/x" }),
  createCustomerPortal: async () => ({ url: "https://creem.io/portal" }),
  moderatePrompt: async () => ({ decision: "allow" }),
};

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let eventLog: SessionEventLog;
let credits: MemoryCreditRepository;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-creem-webhook-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const sessions = new InMemorySessionRepository();
  credits = new MemoryCreditRepository();
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts,
    phases: new PhaseRegistry(), intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(), sessions, messages: new InMemoryMessageStore(), credits,
  });
  eventLog = new SessionEventLog({ events, store: new InMemoryEventStore(), batchMs: 0 });
  const deps: AppDeps = {
    workspaces, events, artifacts, phases: new PhaseRegistry(), orchestrator, eventLog,
    auth: fakeAuthService(null), // logged OUT: the webhook must not need a session
    sessions, credits,
    creem: { config, client: fakeClient },
  };
  // billingStubs keeps a JSON-parsing POST route (/api/billing/grant)
  // registered so we can prove the raw-body parser stays scoped to the
  // webhook plugin and does not hijack app-wide JSON parsing.
  app = await createApp(deps, { billingStubs: true });
});

afterEach(async () => {
  await app.close();
  await eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

const event = JSON.stringify({
  id: "evt_1",
  eventType: "checkout.completed",
  object: {
    id: "ch_1",
    metadata: { userId: "u-hook" },
    order: { id: "ord_1", amount: 2000, product: "prod_credits" },
    product: "prod_credits",
    customer: "cust_1",
  },
});
const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest("hex");

describe("POST /api/webhooks/creem", () => {
  it("applies a correctly-signed event without any auth session", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/webhooks/creem",
      headers: { "content-type": "application/json", "creem-signature": sign(event) },
      payload: event,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(await credits.getBalance("u-hook")).toBe(2000);
  });

  it("rejects a bad or missing signature with 401 and applies nothing", async () => {
    const bad = await app.inject({
      method: "POST", url: "/api/webhooks/creem",
      headers: { "content-type": "application/json", "creem-signature": sign(event, "wrong") },
      payload: event,
    });
    expect(bad.statusCode).toBe(401);
    const missing = await app.inject({
      method: "POST", url: "/api/webhooks/creem",
      headers: { "content-type": "application/json" },
      payload: event,
    });
    expect(missing.statusCode).toBe(401);
    expect(await credits.getBalance("u-hook")).toBe(0);
  });

  it("400s on signed-but-unparseable JSON", async () => {
    const junk = "{not json";
    const res = await app.inject({
      method: "POST", url: "/api/webhooks/creem",
      headers: { "content-type": "application/json", "creem-signature": sign(junk) },
      payload: junk,
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not break JSON parsing on other routes (parser is scoped)", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    // Body parsing runs BEFORE the auth preHandler in Fastify's lifecycle, so a
    // 401 (not 400/415) proves normal JSON parsing survived on this POST route.
    const res = await app.inject({
      method: "POST",
      url: "/api/billing/grant",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ usd: 20 }),
    });
    expect(res.statusCode).toBe(401);
  });
});
