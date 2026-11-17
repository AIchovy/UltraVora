import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, ServerEvent, UserMessage } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { PhaseRegistry } from "../src/phases/registry.js";
import { FakePhaseHandler } from "../src/phases/fake-handler.js";
import type { PhaseHandler } from "../src/phases/types.js";
import { RuleBasedIntentRouter } from "../src/intent/intent-router.js";
import { LLMIntentRouter } from "../src/intent/llm-intent-router.js";
import { SessionOrchestrator } from "../src/orchestrator/session-orchestrator.js";
import { InMemorySessionRepository } from "./helpers/in-memory-session-repository.js";
import { InMemoryMessageStore } from "./helpers/in-memory-message-store.js";
import type { Model } from "@earendil-works/pi-ai";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-orch-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const briefFor = (m: UserMessage): Brief => ({
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: m.constraints ?? { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
});

const designData = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades",
  keyVisuals: [],
  sampleFrames: [],
};
const scriptData = {
  totalSec: 30,
  scenes: [{ id: "s1", startSec: 0, durationSec: 5, visual: "v" }],
};

function buildHandlers(): Map<string, PhaseHandler> {
  return new Map<string, PhaseHandler>([
    ["research", new FakePhaseHandler({
      phase: "research",
      progress: ["scraping"],
      produce: async (ctx) => [{ kind: "brief", data: briefFor(ctx.initialMessage!) }],
    })],
    ["design", new FakePhaseHandler({
      phase: "design",
      produce: async () => [{ kind: "design", data: designData }],
    })],
    ["script", new FakePhaseHandler({
      phase: "script",
      produce: async () => [{ kind: "script", data: scriptData }],
    })],
    ["voiceover", new FakePhaseHandler({
      phase: "voiceover",
      produce: async () => [{ kind: "narration", data: { totalMs: 10000, segments: [{ sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 10000 }] } }],
    })],
    ["compose", new FakePhaseHandler({
      phase: "compose",
      produce: async () => [{ kind: "composition", data: { dir: "composition", entry: "index.html" } }],
    })],
    ["render", new FakePhaseHandler({
      phase: "render",
      produce: async () => [
        { kind: "mp4", data: { path: "output/out.mp4" } },
      ],
    })],
  ]);
}

function buildOrchestrator(opts: { handlers?: Map<import("@ultracreator/shared").PhaseId, PhaseHandler> } = {}) {
  const workspaces = new WorkspaceManager(root);
  const events = new EventBus();
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const phases = new PhaseRegistry();
  const intentRouter = new RuleBasedIntentRouter();
  const handlers = opts.handlers ?? (buildHandlers() as Map<import("@ultracreator/shared").PhaseId, PhaseHandler>);
  const sessions = new InMemorySessionRepository();
  const messages = new InMemoryMessageStore();
  const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers, sessions, messages });
  return { orch, workspaces, events, artifacts, phases, sessions, messages };
}

describe("SessionOrchestrator: new-project", () => {
  it("getState returns idle for an unknown session", () => {
    const { orch } = buildOrchestrator();
    expect(orch.getState("nope")).toEqual({ kind: "idle" });
  });

  it("runs research, settles at awaiting-gate:research, then approve runs design to its gate", async () => {
    const { orch, events } = buildOrchestrator();
    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));

    await orch.handleMessage("s1", {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });

    // Research gates first so the user can curate the captured source assets
    // before design derives keyVisuals from them.
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" });

    const types = seen.map((e) => e.type);
    expect(types).toEqual([
      "user.message",
      "phase.started",
      "phase.progress",
      "artifact.created",
      "gate.awaiting",
    ]);
    // The user's turn is now recorded as the first event so it replays on reload.
    expect(seen[0]).toMatchObject({ type: "user.message", text: "Make a promo for Acme" });
    expect(seen[1]).toMatchObject({ type: "phase.started", phase: "research" });
    expect(seen.at(-1)).toEqual({ type: "gate.awaiting", phase: "research" });

    // Approving the research gate runs design and parks at design's gate.
    await orch.handleMessage("s1", { text: "approve" });
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    expect(seen.slice(5).map((e) => e.type)).toEqual([
      "user.message",
      "phase.started",
      "artifact.created",
      "gate.awaiting",
    ]);
    expect(seen[6]).toMatchObject({ type: "phase.started", phase: "design" });
    expect(seen.at(-1)).toEqual({ type: "gate.awaiting", phase: "design" });
  });

  it("emits phase.error and stops if a handler throws", async () => {
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
    const phases = new PhaseRegistry();
    const intentRouter = new RuleBasedIntentRouter();
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({
        phase: "research",
        produce: async () => { throw new Error("scrape failed"); },
      })],
    ]);
    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers, sessions: new InMemorySessionRepository(), messages: new InMemoryMessageStore() });

    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));

    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });

    expect(orch.getState("s1")).toEqual({
      kind: "error",
      phase: "research",
      error: "scrape failed",
    });
    expect(seen.at(-1)).toEqual({ type: "phase.error", phase: "research", error: "scrape failed" });
  });

  it("logs a phase failure to console.error, since it otherwise leaves zero trace beyond the DB row", async () => {
    // Regression: prod session 238388c4 failed with "fetch failed" during the
    // design phase and journalctl had NOTHING — the orchestrator only ever
    // wrote the error to creator_sessions, never to console/pino.
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
    const phases = new PhaseRegistry();
    const intentRouter = new RuleBasedIntentRouter();
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({
        phase: "research",
        produce: async () => { throw new Error("fetch failed"); },
      })],
    ]);
    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers, sessions: new InMemorySessionRepository(), messages: new InMemoryMessageStore() });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await orch.handleMessage("s1", {
        text: "Start",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("research phase failed for session s1: fetch failed"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("includes the error cause chain in phase.error, not just the top message", async () => {
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
    const phases = new PhaseRegistry();
    const intentRouter = new RuleBasedIntentRouter();
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({
        phase: "research",
        produce: async () => {
          // Same shape as undici's fetch errors: the detail lives on err.cause.
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("Connect Timeout Error"), {
              code: "UND_ERR_CONNECT_TIMEOUT",
            }),
          });
        },
      })],
    ]);
    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers, sessions: new InMemorySessionRepository(), messages: new InMemoryMessageStore() });

    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));

    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });

    const state = orch.getState("s1");
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.error).toContain("fetch failed");
      expect(state.error).toContain("UND_ERR_CONNECT_TIMEOUT");
    }
    const errEvent = seen.at(-1);
    expect(errEvent).toMatchObject({ type: "phase.error", phase: "research" });
    expect((errEvent as { error: string }).error).toContain("UND_ERR_CONNECT_TIMEOUT");
  });

  it("ignores a non-new-project first message (no constraints)", async () => {
    const { orch } = buildOrchestrator();
    await orch.handleMessage("s1", { text: "hi" });
    expect(orch.getState("s1")).toEqual({ kind: "idle" });
  });
});

describe("SessionOrchestrator: approve", () => {
  it("happy path: new-project → approve(research) → approve(design) → approve(script) → done (skips voiceover when withVoiceover=false)", async () => {
    const { orch, events, artifacts } = buildOrchestrator();
    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));

    await orch.handleMessage("s1", {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" });

    await orch.handleMessage("s1", { text: "approve" }); // approve research (asset-curation gate)
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    await orch.handleMessage("s1", { text: "looks good" });
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "script" });

    await orch.handleMessage("s1", { text: "approve" });
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });

    const list = await artifacts.list("s1");
    expect(list.find((d) => d.kind === "narration")).toBeUndefined();
    expect(list.find((d) => d.kind === "mp4")).toBeDefined();
    expect(list.find((d) => d.kind === "composition")).toBeDefined(); // produced by compose phase
  });

  it("includes the voiceover phase when withVoiceover=true, gating on the generated audio", async () => {
    const { orch, artifacts } = buildOrchestrator();

    await orch.handleMessage("s1", {
      text: "Make a promo",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
    });
    await orch.handleMessage("s1", { text: "approve" }); // approve research (asset-curation gate)
    await orch.handleMessage("s1", { text: "approve" }); // approve design
    await orch.handleMessage("s1", { text: "approve" }); // approve script
    // The generated narration is a paid, user-audible artifact: it must pause
    // for review instead of flowing straight into compose/render.
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "voiceover" });
    await orch.handleMessage("s1", { text: "approve" }); // approve voiceover
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });

    const list = await artifacts.list("s1");
    expect(list.find((d) => d.kind === "narration")).toBeDefined();
  });

  it("approve outside a gate is a no-op", async () => {
    const { orch } = buildOrchestrator();
    expect(orch.getState("s1")).toEqual({ kind: "idle" });
    await orch.handleMessage("s1", { text: "approve" });
    expect(orch.getState("s1")).toEqual({ kind: "idle" });
  });
});

describe("SessionOrchestrator: refine", () => {
  it("re-runs the gated phase with the refinement text and creates a new version", async () => {
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
    const phases = new PhaseRegistry();
    const intentRouter = new RuleBasedIntentRouter();

    const refinements: string[] = [];
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({
        phase: "research",
        produce: async (ctx) => [{ kind: "brief", data: briefFor(ctx.initialMessage!) }],
      })],
      ["design", new FakePhaseHandler({
        phase: "design",
        produce: async (ctx) => {
          if (ctx.refinement) refinements.push(ctx.refinement);
          const existing = await ctx.artifacts.get("s1", "design");
          const data = { ...designData, mood: ctx.refinement ?? "energetic" };
          return [{
            kind: "design",
            data,
            derivedFrom: existing
              ? [{ kind: "design" as const, version: existing.version }]
              : [{ kind: "brief" as const, version: 1 }],
          }];
        },
      })],
    ]);
    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers, sessions: new InMemorySessionRepository(), messages: new InMemoryMessageStore() });

    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orch.handleMessage("s1", { text: "approve" }); // approve research (asset-curation gate)
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    await orch.handleMessage("s1", { text: "warmer colors please" });

    expect(refinements).toEqual(["warmer colors please"]);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    const list = await artifacts.list("s1");
    const designs = list.filter((d) => d.kind === "design");
    expect(designs).toHaveLength(2);
    expect(designs[1]!.derivedFrom).toEqual([{ kind: "design", version: 1 }]);

    const latest = await artifacts.get<typeof designData>("s1", "design");
    expect(latest!.data.mood).toBe("warmer colors please");
  });

  it("refine in idle state is a no-op", async () => {
    const { orch } = buildOrchestrator();
    await orch.handleMessage("s1", { text: "hello?" });
    expect(orch.getState("s1")).toEqual({ kind: "idle" });
  });
});

describe("SessionOrchestrator: revise-back + update-brief", () => {
  it("revise-back to design while at script gate: marks script stale and re-enters design", async () => {
    const { orch, events, artifacts } = buildOrchestrator();
    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));

    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orch.handleMessage("s1", { text: "approve" }); // approve research (asset-curation gate)
    await orch.handleMessage("s1", { text: "approve" }); // now awaiting-gate:script
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "script" });

    await orch.handleMessage("s1", { text: "go back to design and use warmer colors" });

    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    const list = await artifacts.list("s1");
    const script = list.find((d) => d.kind === "script")!;
    expect(script.stale).toBe(true);

    const designs = list.filter((d) => d.kind === "design");
    expect(designs).toHaveLength(2);

    expect(seen).toContainEqual({ type: "artifact.stale", kind: "script", version: 1 });
  });

  it("revise-back without an explicit target falls back to the previous phase", async () => {
    const { orch } = buildOrchestrator();
    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orch.handleMessage("s1", { text: "approve" }); // approve research (asset-curation gate)
    await orch.handleMessage("s1", { text: "approve" }); // awaiting-gate:script
    await orch.handleMessage("s1", { text: "/back" }); // no explicit target → previous(script) = design
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });

  it("update-brief at script gate: marks downstream stale and re-runs research", async () => {
    const { orch, artifacts } = buildOrchestrator();
    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orch.handleMessage("s1", { text: "approve" }); // approve research (asset-curation gate)
    await orch.handleMessage("s1", { text: "approve" }); // awaiting-gate:script
    await orch.handleMessage("s1", { text: "change duration to 60s" });

    // The re-run research parks at its asset-curation gate again; approving it
    // lets design re-derive from the updated brief.
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" });
    await orch.handleMessage("s1", { text: "approve" });

    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    const list = await artifacts.list("s1");
    expect(list.find((d) => d.kind === "script")!.stale).toBe(true);
    expect(list.filter((d) => d.kind === "brief")).toHaveLength(2);
    expect(list.filter((d) => d.kind === "design")).toHaveLength(2);
  });
});

describe("SessionOrchestrator: abort + branch/ask", () => {
  it("abort cancels the in-flight phase", async () => {
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
    const phases = new PhaseRegistry();
    const intentRouter = new RuleBasedIntentRouter();

    const slowResearch = new FakePhaseHandler({
      phase: "research",
      produce: (ctx) => new Promise((_resolve, reject) => {
        if (ctx.signal.aborted) reject(new Error("Aborted"));
        ctx.signal.addEventListener("abort", () => reject(new Error("Aborted")));
      }),
    });
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", slowResearch],
    ]);
    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers, sessions: new InMemorySessionRepository(), messages: new InMemoryMessageStore() });

    const started = orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });

    // Poll until the queue actually starts the phase — a fixed sleep races
    // under parallel-suite CPU contention.
    const deadline = Date.now() + 2_000;
    while (orch.getState("s1").kind !== "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(orch.getState("s1")).toEqual({ kind: "running", phase: "research" });

    await orch.handleMessage("s1", { text: "abort" });

    await started;

    const state = orch.getState("s1");
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.phase).toBe("research");
      expect(state.error).toMatch(/abort/i);
    }
  });

  it("abort with nothing running is a no-op (no throw, state unchanged)", async () => {
    const { orch } = buildOrchestrator();
    await orch.handleMessage("s1", { text: "abort" });
    expect(orch.getState("s1")).toEqual({ kind: "idle" });
  });

  it("branch is a v1 no-op", async () => {
    const { orch } = buildOrchestrator();
    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    const before = orch.getState("s1");
    await orch.handleMessage("s1", { text: "/branch" });
    expect(orch.getState("s1")).toEqual(before);
  });

  it("ask emits intent.unhandled instead of silently dropping the message", async () => {
    const { orch, events } = buildOrchestrator();
    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));

    // idle state, no constraints → classified as ask
    await orch.handleMessage("s1", { text: "what does this do?" });

    expect(orch.getState("s1")).toEqual({ kind: "idle" });
    const last = seen.at(-1);
    expect(last).toMatchObject({ type: "intent.unhandled" });
  });

  it("abort fired between phases stops the chain before the next phase begins", async () => {
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
    const phases = new PhaseRegistry();
    const intentRouter = new RuleBasedIntentRouter();
    // Research now gates for asset curation, which would park the chain before
    // the between-phases window this test exercises. Auto-approve keeps the
    // chain flowing so the abort lands after research finishes and before
    // design begins.
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: "s1", userId: "u", autoApprove: true });

    let designInvoked = false;
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({
        phase: "research",
        // Research finishes normally — writes brief, no progress, no hang.
        produce: async (ctx) => [{ kind: "brief", data: briefFor(ctx.initialMessage!) }],
      })],
      ["design", new FakePhaseHandler({
        phase: "design",
        produce: async () => {
          designInvoked = true;
          return [{ kind: "design", data: designData }];
        },
      })],
    ]);

    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers, sessions, messages: new InMemoryMessageStore() });

    // Subscribe BEFORE start: abort the moment we see artifact.created:brief.
    // That moment is between research (just produced its artifact) and design.
    events.subscribe("s1", (e) => {
      if (e.type === "artifact.created" && e.kind === "brief") {
        // Fire-and-forget — pre-classify path is synchronous through the router.
        void orch.handleMessage("s1", { text: "abort" });
      }
    });

    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });

    // Design must NEVER have run, even though research completed.
    expect(designInvoked).toBe(false);
    const state = orch.getState("s1");
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.error).toMatch(/abort/i);
    }
  });
});

describe("SessionOrchestrator: state recovery after restart", () => {
  it("rehydrates awaiting-gate from the repository so /approve resumes", async () => {
    const { orch, workspaces, artifacts, events, sessions } = buildOrchestrator();
    await workspaces.init("s1");
    await sessions.create({ id: "s1", userId: "u1" });

    // Upstream artifacts still live on disk (ArtifactStore unchanged this phase).
    const brief = briefFor({
      text: "x",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await artifacts.put("s1", "brief", brief);
    await artifacts.put("s1", "design", designData);

    // Simulate a prior process that reached the design approval gate: state in the repo.
    await sessions.updateStatus("s1", { status: "awaiting-gate", currentPhase: "design", error: null });

    // This process's in-memory state map is empty (fresh orchestrator), so it
    // recovers from the repo on first touch.
    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));
    expect(orch.getState("s1")).toEqual({ kind: "idle" });

    await orch.handleMessage("s1", { text: "/approve" });

    expect(
      seen.some((e) => e.type === "phase.started" && (e as { phase: string }).phase === "script"),
    ).toBe(true);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "script" });
  });

  it("stays idle when the repository has no record (fresh session)", async () => {
    const { orch, workspaces } = buildOrchestrator();
    await workspaces.init("s2");
    await orch.handleMessage("s2", { text: "/approve" });
    expect(orch.getState("s2")).toEqual({ kind: "idle" });
  });

  it("restores the initial message across a restart so research re-runs with it", async () => {
    const initial: UserMessage = {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    };
    // Share one repo across both simulated processes (stands in for PG persistence).
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: "s1", userId: "u1" });

    // Process 1: research throws -> error state (orchestrator persists it to the repo).
    {
      const workspaces = new WorkspaceManager(root);
      const events = new EventBus();
      const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
      const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
        ["research", new FakePhaseHandler({
          phase: "research",
          produce: async () => { throw new Error("scrape failed"); },
        })],
      ]);
      const orch = new SessionOrchestrator({
        workspaces, events, artifacts,
        phases: new PhaseRegistry(),
        intentRouter: new RuleBasedIntentRouter(),
        handlers, sessions, messages: new InMemoryMessageStore(),
      });
      await orch.handleMessage("s1", initial);
      expect(orch.getState("s1")).toMatchObject({ kind: "error", phase: "research" });
    }

    // Process 2: fresh orchestrator (empty in-memory), shared repo + same disk root.
    // A refine message must re-run research with the ORIGINAL initial message
    // (restored from initial-message.json on disk).
    const received: (UserMessage | undefined)[] = [];
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({
        phase: "research",
        produce: async (ctx) => {
          received.push(ctx.initialMessage);
          return [{ kind: "brief", data: briefFor(ctx.initialMessage!) }];
        },
      })],
      ["design", new FakePhaseHandler({
        phase: "design",
        produce: async () => [{ kind: "design", data: designData }],
      })],
    ]);
    const orch = new SessionOrchestrator({
      workspaces, events, artifacts,
      phases: new PhaseRegistry(),
      intentRouter: new RuleBasedIntentRouter(),
      handlers, sessions, messages: new InMemoryMessageStore(),
    });

    await orch.handleMessage("s1", { text: "retry that please" });

    expect(received).toEqual([initial]);
    // The re-run parks at research's asset-curation gate; approving it still
    // advances into design as before the restart.
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" });
    await orch.handleMessage("s1", { text: "approve" });
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });
});

describe("SessionOrchestrator: LLM intent router integration", () => {
  it("re-runs a failed phase when the LLM classifies '重试' as refine", async () => {
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
    const phases = new PhaseRegistry();
    let researchRuns = 0;
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({
        phase: "research",
        produce: async (ctx) => {
          researchRuns++;
          if (researchRuns === 1) throw new Error("scrape failed");
          return [{ kind: "brief", data: briefFor(ctx.initialMessage!) }];
        },
      })],
      ["design", new FakePhaseHandler({
        phase: "design",
        produce: async () => [{ kind: "design", data: designData }],
      })],
    ]);
    const intentRouter = new LLMIntentRouter({
      model: { provider: "anthropic", id: "claude-test" } as unknown as Model<any>,
      fallback: new RuleBasedIntentRouter(),
      completeFn: () => Promise.resolve({
        content: [{ type: "text", text: '{"intent":"refine"}' }],
        stopReason: "stop",
      }),
    });
    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers, sessions: new InMemorySessionRepository(), messages: new InMemoryMessageStore() });

    await orch.handleMessage("s1", {
      text: "Make a promo",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(orch.getState("s1")).toMatchObject({ kind: "error", phase: "research" });

    await orch.handleMessage("s1", { text: "重试" });
    expect(researchRuns).toBe(2);
    // The re-run parks at research's asset-curation gate. "/approve" is a
    // slash command, so it routes deterministically (never through the canned
    // always-refine LLM) and advances the chain into design.
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" });
    await orch.handleMessage("s1", { text: "/approve" });
    expect(researchRuns).toBe(2);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });
});

describe("SessionOrchestrator: durable message queue", () => {
  const newProject = {
    text: "Make a promo for Acme",
    constraints: { durationSec: 30 as const, aspectRatio: "16:9" as const, withVoiceover: false },
  };

  it("a handled message ends done with started/finished stamps", async () => {
    const { orch, messages } = buildOrchestrator();
    await orch.handleMessage("s1", newProject);
    const rows = messages.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: "s1", status: "done" });
    expect(rows[0]!.payload).toEqual(newProject);
    expect(rows[0]!.startedAt).not.toBeNull();
    expect(rows[0]!.finishedAt).not.toBeNull();
  });

  it("a phase failure marks the message error", async () => {
    const handlers = buildHandlers() as Map<import("@ultracreator/shared").PhaseId, PhaseHandler>;
    handlers.set("research", new FakePhaseHandler({
      phase: "research",
      produce: async () => { throw new Error("boom"); },
    }));
    const { orch, messages } = buildOrchestrator({ handlers });
    await orch.handleMessage("s1", newProject);
    expect(messages.all()[0]).toMatchObject({ sessionId: "s1", status: "error" });
    expect(messages.all()[0]!.finishedAt).not.toBeNull();
    expect(messages.all()[0]!.startedAt).not.toBeNull();
  });

  it("an abort during a run bypasses the queue and is NOT persisted", async () => {
    // Slow handler so the chain is in flight (controller live) when the abort
    // arrives — the pre-queue bypass only fires for an actual in-flight run.
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>();
    handlers.set("research", new FakePhaseHandler({
      phase: "research",
      produce: (ctx) =>
        new Promise((_, reject) => {
          if (ctx.signal.aborted) reject(new Error("Aborted"));
          ctx.signal.addEventListener("abort", () => reject(new Error("Aborted")));
        }),
    }));
    const { orch, messages } = buildOrchestrator({ handlers });
    const first = orch.handleMessage("s1", newProject);
    await vi.waitFor(() => expect(orch.getState("s1")).toEqual({ kind: "running", phase: "research" }));

    await orch.handleMessage("s1", { text: "abort" });
    await first.catch(() => undefined);

    // Only the project message persisted; the abort was a pure control signal.
    expect(messages.all().map((r) => r.payload.text)).toEqual(["Make a promo for Acme"]);
  });

  it("an abort with nothing running is persisted and completes as a no-op", async () => {
    // No live controller → nothing to interrupt; the message flows through
    // classification like any other (a stop-leading adjustment on a done
    // session must not vanish).
    const { orch, messages } = buildOrchestrator();
    await orch.handleMessage("s1", { text: "abort" });
    expect(messages.all()).toHaveLength(1);
    expect(messages.all()[0]).toMatchObject({ status: "done" });
  });

  it("two messages persist as two rows in arrival order", async () => {
    const { orch, messages } = buildOrchestrator();
    await orch.handleMessage("s1", newProject); // → awaiting-gate research
    await orch.handleMessage("s1", { text: "make the palette warmer" }); // refine research
    const rows = messages.all();
    expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
    expect(rows.map((r) => r.payload.text)).toEqual([
      "Make a promo for Acme",
      "make the palette warmer",
    ]);
  });
});

describe("SessionOrchestrator: autoApprove", () => {
  it("autoApprove=true skips every gate and runs straight to done", async () => {
    const { orch, events, sessions } = buildOrchestrator();
    await sessions.create({ id: "auto1", userId: "u", autoApprove: true });
    const seen: ServerEvent[] = [];
    events.subscribe("auto1", (e) => seen.push(e));

    await orch.handleMessage("auto1", {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });

    expect(orch.getState("auto1")).toEqual({ kind: "done", lastPhase: "render" });
    expect(seen.some((e) => e.type === "gate.awaiting")).toBe(false);
    // research + design + script (voiceover disabled by withVoiceover=false).
    expect(
      seen.filter((e) => e.type === "phase.progress" && e.message.startsWith("Auto-approved")).length,
    ).toBe(3);
  });

  it("flipping autoApprove on at a gate resumes to done", async () => {
    const { orch, sessions } = buildOrchestrator();
    await sessions.create({ id: "flip1", userId: "u", autoApprove: false });

    await orch.handleMessage("flip1", {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orch.handleMessage("flip1", { text: "approve" }); // approve research (asset-curation gate)
    expect(orch.getState("flip1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    await orch.setAutoApprove("flip1", true);
    await vi.waitFor(() =>
      expect(orch.getState("flip1")).toEqual({ kind: "done", lastPhase: "render" }),
    );
  });

  it("setAutoApprove on a non-gated session only persists the flag", async () => {
    const { orch, sessions } = buildOrchestrator();
    await sessions.create({ id: "idle1", userId: "u", autoApprove: false });
    await orch.setAutoApprove("idle1", true);
    expect((await sessions.get("idle1"))?.autoApprove).toBe(true);
    expect(orch.getState("idle1")).toEqual({ kind: "idle" });
  });

  it("setAutoApprove(false) while parked at a gate keeps it parked", async () => {
    const { orch, sessions } = buildOrchestrator();
    await sessions.create({ id: "off1", userId: "u", autoApprove: false });
    await orch.handleMessage("off1", {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orch.handleMessage("off1", { text: "approve" }); // approve research (asset-curation gate)
    expect(orch.getState("off1")).toEqual({ kind: "awaiting-gate", phase: "design" });
    await orch.setAutoApprove("off1", false);
    expect((await sessions.get("off1"))?.autoApprove).toBe(false);
    expect(orch.getState("off1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });
});

describe("SessionOrchestrator: forget", () => {
  it("releases a session's in-memory state so getState reports idle again", async () => {
    const { orch } = buildOrchestrator();
    await orch.handleMessage("s1", {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orch.handleMessage("s1", { text: "approve" }); // approve research (asset-curation gate)
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    orch.forget("s1");

    // getState reads the in-memory map (no repo rehydrate), so an idle result
    // here proves the parked state was dropped from memory, not just the row.
    expect(orch.getState("s1")).toEqual({ kind: "idle" });
  });

  it("forgetting an unknown session is a no-op", () => {
    const { orch } = buildOrchestrator();
    expect(() => orch.forget("never-seen")).not.toThrow();
    expect(orch.getState("never-seen")).toEqual({ kind: "idle" });
  });
});

describe("media restore before phase runs", () => {
  // Research now gates (asset curation), so the chain parks at research's
  // user-approve gate right after the handler runs. The no-op design handler
  // keeps the map complete in case that gate is ever approved or removed —
  // without it the chain would throw "No handler registered for phase design".
  const noopDesign: PhaseHandler = {
    phase: "design",
    // eslint-disable-next-line require-yield
    async *run() {
      return;
    },
  };

  it("awaits media.restoreMissing before the first handler starts", async () => {
    const calls: string[] = [];
    const handler: PhaseHandler = {
      phase: "research",
      // eslint-disable-next-line require-yield
      async *run() {
        calls.push("handler");
        return;
      },
    };
    const media = {
      restoreMissing: async (sid: string) => {
        calls.push(`restore-start:${sid}`);
        await new Promise((r) => setTimeout(r, 0));
        calls.push("restore-done");
      },
    };
    const root = mkdtempSync(join(tmpdir(), "uc-orch-media-"));
    try {
      const events = new EventBus();
      const orchestrator = new SessionOrchestrator({
        workspaces: new WorkspaceManager(root),
        events,
        artifacts: new ArtifactStore(new InMemoryArtifactRepository(), events),
        phases: new PhaseRegistry(),
        intentRouter: new RuleBasedIntentRouter(),
        handlers: new Map([["research", handler], ["design", noopDesign]]),
        sessions: new InMemorySessionRepository(),
        messages: new InMemoryMessageStore(),
        media,
      });
      await orchestrator.handleMessage("m1", {
        text: "make a promo",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      });
      expect(calls.slice(0, 3)).toEqual(["restore-start:m1", "restore-done", "handler"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a throwing restoreMissing does not break the run", async () => {
    let ran = false;
    const handler: PhaseHandler = {
      phase: "research",
      // eslint-disable-next-line require-yield
      async *run() {
        ran = true;
        return;
      },
    };
    const root = mkdtempSync(join(tmpdir(), "uc-orch-media2-"));
    try {
      const events = new EventBus();
      const orchestrator = new SessionOrchestrator({
        workspaces: new WorkspaceManager(root),
        events,
        artifacts: new ArtifactStore(new InMemoryArtifactRepository(), events),
        phases: new PhaseRegistry(),
        intentRouter: new RuleBasedIntentRouter(),
        handlers: new Map([["research", handler], ["design", noopDesign]]),
        sessions: new InMemorySessionRepository(),
        messages: new InMemoryMessageStore(),
        media: { restoreMissing: async () => { throw new Error("GCS down"); } },
      });
      await orchestrator.handleMessage("m2", {
        text: "make a promo",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      });
      expect(ran).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
