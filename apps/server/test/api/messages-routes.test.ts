// apps/server/test/api/messages-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { FakePhaseHandler } from "../../src/phases/fake-handler.js";
import { createApp, type AppDeps } from "../../src/api/app.js";
import { fakeAuthService } from "../helpers/fake-auth.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";
import type { PhaseId, ServerEvent } from "@ultracreator/shared";
import { creemConfigFromEnv } from "../../src/billing/creem-config.js";
import type { CreemClient, CreemModerationDecision } from "../../src/billing/creem-client.js";

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let sessionId: string;

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};
const designData = {
  mood: "energetic", palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades", keyVisuals: [], sampleFrames: [],
};
const scriptData = {
  totalSec: 30,
  scenes: [{ id: "s1", startSec: 0, durationSec: 30, visual: "logo" }],
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-msg-route-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const phases = new PhaseRegistry();
  const handlers = new Map<PhaseId, FakePhaseHandler>([
    ["research", new FakePhaseHandler({ phase: "research", produce: async () => [{ kind: "brief", data: briefData }] })],
    ["design",   new FakePhaseHandler({ phase: "design",   produce: async () => [{ kind: "design", data: designData }] })],
    ["script",   new FakePhaseHandler({ phase: "script",   produce: async () => [{ kind: "script", data: scriptData }] })],
    ["render",   new FakePhaseHandler({ phase: "render",   produce: async (ctx) => [
      { kind: "composition", data: { dir: "composition", entry: "index.html" } },
      { kind: "mp4", data: { path: join(ctx.workspaces.paths(ctx.sessionId).output, "out.mp4") } },
    ]})],
  ]);
  const sessions = new InMemorySessionRepository();
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts, phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers,
    sessions,
    messages: new InMemoryMessageStore(),
  });
  const eventLog = new SessionEventLog({ events, store: new InMemoryEventStore(), batchMs: 0 });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog, auth: fakeAuthService(), sessions };
  app = await createApp(deps);
  sessionId = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

async function waitForGate(sid: string, phase?: PhaseId, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const state = deps.orchestrator.getState(sid);
    if (state.kind === "awaiting-gate" && (!phase || state.phase === phase)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`gate ${phase ?? "*"} not reached, last state: ${JSON.stringify(deps.orchestrator.getState(sid))}`);
}

describe("messages route", () => {
  it("POST /api/sessions/:sid/messages with constraints kicks off the pipeline (gates at research, then design after approve)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: {
        text: "make me a promo",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    // Research gates first so the user can curate the captured source assets.
    await waitForGate(sessionId, "research");
    expect(deps.orchestrator.getState(sessionId)).toEqual({ kind: "awaiting-gate", phase: "research" });

    // approve research (asset-curation gate) → design runs and parks at its gate
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: "/approve" },
    });
    await waitForGate(sessionId, "design");
    expect(deps.orchestrator.getState(sessionId)).toEqual({ kind: "awaiting-gate", phase: "design" });
  });

  it("POST /api/sessions/:sid/messages with /approve advances past a gate", async () => {
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: {
        text: "go",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      },
    });
    await waitForGate(sessionId, "research");
    // approve research (asset-curation gate)
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: "/approve" },
    });
    await waitForGate(sessionId, "design");
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: "/approve" },
    });
    // After approve, the orchestrator should reach the SCRIPT gate.
    await waitForGate(sessionId, "script");
    expect(deps.orchestrator.getState(sessionId)).toEqual({ kind: "awaiting-gate", phase: "script" });
  });

  it("POST /api/sessions/:sid/messages with /abort flips state out of running", async () => {
    // Replace research with a slow handler we can interrupt.
    deps.orchestrator = new SessionOrchestrator({
      workspaces: deps.workspaces,
      events: deps.events,
      artifacts: deps.artifacts,
      phases: deps.phases,
      intentRouter: new RuleBasedIntentRouter(),
      sessions: deps.sessions,
      messages: new InMemoryMessageStore(),
      handlers: new Map([
        ["research", new FakePhaseHandler({
          phase: "research",
          produce: async (ctx) => {
            await new Promise((resolve, reject) => {
              const t = setTimeout(resolve, 5000);
              ctx.signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("Aborted")); });
            });
            return [{ kind: "brief", data: briefData }];
          },
        })],
      ]),
    });
    await app.close();
    app = await createApp(deps);
    sessionId = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;

    void app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: {
        text: "go",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      },
    });
    // wait for "running"
    const start = Date.now();
    while (Date.now() - start < 500 && deps.orchestrator.getState(sessionId).kind !== "running") {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(deps.orchestrator.getState(sessionId).kind).toBe("running");
    const abort = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: "/abort" },
    });
    expect(abort.statusCode).toBe(202);
    // wait for error state
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && deps.orchestrator.getState(sessionId).kind === "running") {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(deps.orchestrator.getState(sessionId).kind).toBe("error");
  });

  it("POST /api/sessions/:sid/messages rejects body that does not match UserMessageSchema (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 123 }, // wrong type
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/sessions/:sid/messages is 404 for an unknown session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/nope/messages",
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("emits a user.message event (with text + clientId) so the bubble survives reload", async () => {
    const seen: ServerEvent[] = [];
    deps.events.subscribe(sessionId, (e) => seen.push(e));
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: {
        text: "make me a promo",
        clientId: "c-123",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      },
    });
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !seen.some((e) => e.type === "user.message")) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const evt = seen.find((e) => e.type === "user.message");
    expect(evt).toMatchObject({ type: "user.message", text: "make me a promo", clientId: "c-123" });
    expect(typeof (evt as { at?: unknown }).at).toBe("string");
  });

  it("an abort command with nothing running flows through like a normal message", async () => {
    // The queue-bypass (no user.message echo) only applies while a run is in
    // flight; with nothing to interrupt, the message is persisted and echoed
    // so it can't silently vanish (e.g. "stop the music" adjustments).
    const seen: ServerEvent[] = [];
    deps.events.subscribe(sessionId, (e) => seen.push(e));
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: "/abort" },
    });
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !seen.some((e) => e.type === "user.message")) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(seen.some((e) => e.type === "user.message")).toBe(true);
  });

  it("sets the session title from the first message text", async () => {
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: "Launch teaser\n\nmore detail" },
    });
    expect((await deps.sessions.get(sessionId))?.title).toBe("Launch teaser");
  });

  it("does not overwrite the title on later messages", async () => {
    const send = (text: string) => app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text },
    });
    await send("First title");
    await send("second message");
    expect((await deps.sessions.get(sessionId))?.title).toBe("First title");
  });
});

describe("prompt moderation gate (Creem configured)", () => {
  const config = creemConfigFromEnv({
    CREEM_API_KEY: "creem_test_k", CREEM_WEBHOOK_SECRET: "whsec",
    CREEM_PRODUCT_CREDITS: "prod_credits",
    CREEM_PRODUCT_PRO_MONTHLY: "prod_pm", CREEM_PRODUCT_PRO_YEARLY: "prod_py",
    CREEM_PRODUCT_MAX_MONTHLY: "prod_mm", CREEM_PRODUCT_MAX_YEARLY: "prod_my",
    CREEM_PRODUCT_ULTRA_MONTHLY: "prod_um", CREEM_PRODUCT_ULTRA_YEARLY: "prod_uy",
  })!;

  /** Rebuild the app with a Creem dep whose moderatePrompt runs `behave`. */
  async function withModeration(
    behave: (prompt: string) => Promise<{ decision: CreemModerationDecision }>,
  ): Promise<{ calls: string[] }> {
    const calls: string[] = [];
    const client: CreemClient = {
      createCheckout: async () => ({ checkoutUrl: "https://creem.io/x" }),
      createCustomerPortal: async () => ({ url: "https://creem.io/portal" }),
      moderatePrompt: async (prompt) => {
        calls.push(prompt);
        return behave(prompt);
      },
    };
    await app.close();
    app = await createApp({ ...deps, creem: { config, client } });
    sessionId = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
    return { calls };
  }

  const send = (text: string) =>
    app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { text } });

  it("blocks deny with 422 and never starts the pipeline", async () => {
    await withModeration(async () => ({ decision: "deny" }));
    const res = await send("something disallowed");
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "content_policy" });
    expect(deps.orchestrator.getState(sessionId).kind).not.toBe("awaiting-gate");
  });

  it("blocks flag too (Creem: treat flag as a block)", async () => {
    await withModeration(async () => ({ decision: "flag" }));
    const res = await send("borderline prompt");
    expect(res.statusCode).toBe(422);
  });

  it("fails CLOSED with 503 when moderation is unavailable", async () => {
    await withModeration(async () => {
      throw new Error("upstream down");
    });
    const res = await send("any prompt");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "moderation_unavailable" });
  });

  it("allows clean prompts through to the pipeline", async () => {
    const { calls } = await withModeration(async () => ({ decision: "allow" }));
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: {
        text: "make me a promo",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(calls).toEqual(["make me a promo"]);
    await waitForGate(sessionId);
  });

  it("does not moderate the /approve command", async () => {
    const { calls } = await withModeration(async () => ({ decision: "deny" }));
    const res = await send("/approve");
    expect(res.statusCode).toBe(202);
    expect(calls).toEqual([]);
  });
});
