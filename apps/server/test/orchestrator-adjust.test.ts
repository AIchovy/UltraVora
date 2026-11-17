// Adjust-after-done: a chat message on a finished video must actually change
// the video (refinement reaches compose, mp4 goes stale, render re-runs) and
// must be charged as a new billing run (compose revision base + render) —
// while error retries and credit-park resumes keep deduplicating against the
// already-paid charge.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, PhaseId, ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { PhaseRegistry } from "../src/phases/registry.js";
import { FakePhaseHandler } from "../src/phases/fake-handler.js";
import type { PhaseContext, PhaseHandler } from "../src/phases/types.js";
import { RuleBasedIntentRouter } from "../src/intent/intent-router.js";
import { SessionOrchestrator } from "../src/orchestrator/session-orchestrator.js";
import { InMemorySessionRepository } from "./helpers/in-memory-session-repository.js";
import { InMemoryMessageStore } from "./helpers/in-memory-message-store.js";
import { MemoryCreditRepository } from "../src/credits/memory-credit-repository.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-adjust-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const brief: Brief = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};
const designData = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades",
  keyVisuals: [],
  sampleFrames: [],
};
const scriptData = {
  totalSec: 12,
  scenes: [{ id: "sc1", startSec: 0, durationSec: 12, visual: "logo", onScreenText: "Acme" }],
};

// Fresh run without voiceover/bgm: research 60 + design 55 + script 10 +
// compose 200 + render 15.
const FRESH_TOTAL = 340;
// Adjustment run: compose revision base 160 + render 15.
const ADJUST_TOTAL = 175;

interface Counters {
  composeRuns: number;
  composeRefinements: string[];
  renderRuns: number;
  failRendersRemaining: number;
}

async function build(opts: { credits?: MemoryCreditRepository; isPublic?: boolean; autoApprove?: boolean } = {}) {
  const counters: Counters = {
    composeRuns: 0,
    composeRefinements: [],
    renderRuns: 0,
    failRendersRemaining: 0,
  };
  const sessions = new InMemorySessionRepository();
  await sessions.create({
    id: "s1",
    userId: "u1",
    autoApprove: opts.autoApprove ?? true,
    isPublic: opts.isPublic ?? false,
  });
  const messages = new InMemoryMessageStore();
  const events = new EventBus();
  const seen: ServerEvent[] = [];
  events.subscribe("s1", (e) => seen.push(e));
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const handlers = new Map<PhaseId, PhaseHandler>([
    ["research", new FakePhaseHandler({ phase: "research", produce: async () => [{ kind: "brief", data: brief }] })],
    ["design", new FakePhaseHandler({ phase: "design", produce: async () => [{ kind: "design", data: designData }] })],
    ["script", new FakePhaseHandler({ phase: "script", produce: async () => [{ kind: "script", data: scriptData }] })],
    ["compose", new FakePhaseHandler({
      phase: "compose",
      produce: async (ctx: PhaseContext) => {
        counters.composeRuns++;
        if (ctx.refinement) counters.composeRefinements.push(ctx.refinement);
        return [{ kind: "composition", data: { dir: "composition", entry: "index.html" } }];
      },
    })],
    ["render", new FakePhaseHandler({
      phase: "render",
      produce: async () => {
        counters.renderRuns++;
        if (counters.failRendersRemaining > 0) {
          counters.failRendersRemaining--;
          throw new Error("render worker crashed");
        }
        return [{ kind: "mp4", data: { path: `output/v${counters.renderRuns}.mp4` } }];
      },
    })],
  ]);
  const deps = {
    workspaces: new WorkspaceManager(root),
    events,
    artifacts,
    phases: new PhaseRegistry(),
    intentRouter: new RuleBasedIntentRouter(),
    handlers,
    sessions,
    messages,
    ...(opts.credits ? { credits: opts.credits } : {}),
  };
  const orch = new SessionOrchestrator(deps);
  return { orch, deps, sessions, messages, artifacts, seen, counters };
}

const newProject = {
  text: "Make a promo for Acme",
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
} as const;

describe("adjust-after-done: pipeline flow", () => {
  it("routes the adjustment to compose with the user's text, stales the mp4, and re-renders", async () => {
    const { orch, artifacts, seen, counters } = await build();

    await orch.handleMessage("s1", newProject);
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });
    expect(counters.composeRuns).toBe(1);
    expect(counters.renderRuns).toBe(1);

    await orch.handleMessage("s1", { text: "make the headline blue" });

    // The adjustment reached compose verbatim (render alone can't act on it).
    expect(counters.composeRefinements).toEqual(["make the headline blue"]);
    expect(counters.composeRuns).toBe(2);
    expect(counters.renderRuns).toBe(2);
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });

    const list = await artifacts.list("s1");
    expect(list.filter((d) => d.kind === "composition")).toHaveLength(2);
    const mp4s = list.filter((d) => d.kind === "mp4");
    expect(mp4s.map((d) => d.version)).toEqual([1, 2]);
    expect(mp4s[0]!.stale).toBe(true);
    expect(seen).toContainEqual({ type: "artifact.stale", kind: "mp4", version: 1 });
  });

  it("a stop-leading adjustment on a done session re-runs instead of aborting", async () => {
    // Nothing is running at done, so the pre-queue abort bypass must not
    // swallow "stop the music" — it's an adjustment.
    const { orch, counters } = await build();
    await orch.handleMessage("s1", newProject);
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });

    await orch.handleMessage("s1", { text: "stop the music" });

    expect(counters.composeRefinements).toEqual(["stop the music"]);
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });
  });

  it("crash recovery re-runs a paid adjustment WITH its refinement", async () => {
    // Simulate a restart mid-adjustment: durable row says running@compose with
    // the pending refinement; the interrupted message row is still processing.
    const { deps, sessions, messages, counters } = await build();
    const id = await messages.insert("s1", { text: "make the headline blue" });
    await messages.markProcessing(id);
    await sessions.updateStatus("s1", {
      status: "running",
      currentPhase: "compose",
      error: null,
      pendingRefinement: "make the headline blue",
    });

    const restarted = new SessionOrchestrator(deps);
    await restarted.recover();
    await vi.waitFor(() =>
      expect(restarted.getState("s1")).toEqual({ kind: "done", lastPhase: "render" }),
    );

    // Without the refinement the recovered compose run would silently produce
    // a from-scratch composition the user never asked (but paid) for.
    expect(counters.composeRefinements).toEqual(["make the headline blue"]);
  });
});

describe("adjust-after-done: credit charging", () => {
  it("charges every adjustment run (compose revision base + render), never for free", async () => {
    const credits = new MemoryCreditRepository();
    await credits.grant({
      userId: "u1",
      amount: FRESH_TOTAL + 2 * ADJUST_TOTAL,
      idempotencyKey: "t1",
      reason: "purchase",
    });
    const { orch, counters } = await build({ credits });

    await orch.handleMessage("s1", newProject);
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });
    expect(await credits.getBalance("u1")).toBe(2 * ADJUST_TOTAL);

    await orch.handleMessage("s1", { text: "make the headline blue" });
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });
    expect(await credits.getBalance("u1")).toBe(ADJUST_TOTAL);

    await orch.handleMessage("s1", { text: "now make the ending slower" });
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });
    expect(await credits.getBalance("u1")).toBe(0);

    expect(counters.composeRefinements).toEqual([
      "make the headline blue",
      "now make the ending slower",
    ]);
  });

  it("parks an unaffordable adjustment at compose and keeps the refinement across the top-up resume", async () => {
    const credits = new MemoryCreditRepository();
    await credits.grant({ userId: "u1", amount: FRESH_TOTAL, idempotencyKey: "t1", reason: "purchase" });
    const { orch, seen, counters } = await build({ credits });

    await orch.handleMessage("s1", newProject);
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });
    expect(await credits.getBalance("u1")).toBe(0);

    await orch.handleMessage("s1", { text: "make the headline blue" });

    // The park carries the refinement — that's what the resume replays.
    expect(orch.getState("s1")).toEqual({
      kind: "awaiting-credits",
      phase: "compose",
      refinement: "make the headline blue",
    });
    expect(counters.composeRuns).toBe(1); // parked before any work
    expect(seen).toContainEqual({
      type: "credits.required",
      phase: "compose",
      needed: 160,
      balance: 0,
    });

    await credits.grant({ userId: "u1", amount: ADJUST_TOTAL, idempotencyKey: "t2", reason: "purchase" });
    await orch.resumeCredits("s1");
    await vi.waitFor(() => expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" }));

    // The resumed run still carries the user's adjustment — without it the
    // re-render would produce an identical video after the user paid.
    expect(counters.composeRefinements).toEqual(["make the headline blue"]);
    expect(counters.renderRuns).toBe(2);
    expect(await credits.getBalance("u1")).toBe(0);
  });

  it("free-public-grant covers only the initial run — adjustments charge normally", async () => {
    const credits = new MemoryCreditRepository(); // balance 0
    const { orch, counters } = await build({ credits, isPublic: true });

    // Initial generation rides the free public grant end to end.
    await orch.handleMessage("s1", newProject);
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });
    expect(counters.composeRuns).toBe(1);

    // An adjustment is a new billing run: with a zero balance it must park,
    // not ride the grant into a free compose re-run.
    await orch.handleMessage("s1", { text: "make the headline blue" });
    expect(orch.getState("s1")).toMatchObject({ kind: "awaiting-credits", phase: "compose" });
    expect(counters.composeRuns).toBe(1);
  });

  it("a compose run without a prior composition charges full price even with a refinement", async () => {
    // Revise-back targeting compose from the script gate: compose never ran,
    // so there is nothing to revise — the run authors from scratch (images,
    // music) and must charge the full menu (200), not the revision base (160).
    const credits = new MemoryCreditRepository();
    // research 60 + design 55 + script 10 + compose FULL 200 + render 15 = 340.
    await credits.grant({ userId: "u1", amount: 340, idempotencyKey: "t1", reason: "purchase" });
    const { orch } = await build({ credits, autoApprove: false });

    await orch.handleMessage("s1", newProject);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" });
    await orch.handleMessage("s1", { text: "approve" }); // approve research (asset-curation gate)
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
    await orch.handleMessage("s1", { text: "approve" });
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "script" });

    await orch.handleMessage("s1", { text: "/back compose" });

    // If this had charged the 160 revision base, 40 credits would remain.
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });
    expect(await credits.getBalance("u1")).toBe(0);
  });

  it("retries a failed phase against the already-paid charge (no double charge)", async () => {
    const credits = new MemoryCreditRepository();
    await credits.grant({ userId: "u1", amount: FRESH_TOTAL, idempotencyKey: "t1", reason: "purchase" });
    const { orch, counters } = await build({ credits });
    counters.failRendersRemaining = 1;

    await orch.handleMessage("s1", newProject);
    expect(orch.getState("s1")).toMatchObject({ kind: "error", phase: "render" });
    expect(await credits.getBalance("u1")).toBe(0); // render was charged before it failed

    await orch.handleMessage("s1", { text: "try again" });

    // With a zero balance this only reaches `done` if the retry deduplicated
    // against the fresh run's render charge instead of billing a new run.
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });
    expect(counters.renderRuns).toBe(2);
    expect(await credits.getBalance("u1")).toBe(0);
  });
});
