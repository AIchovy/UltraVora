// Spec §4/§9 acceptance: kill the server mid-pipeline, restart, and the task
// resumes from the interrupted phase. Simulated in-process: orchestrator #1
// runs into a phase that never finishes (the "crash" leaves its queue task
// parked forever and we simply abandon the instance); orchestrator #2 is built
// over the SAME durable stores (the in-memory fakes play the role of PG, the
// tmp workspace dir plays itself) and recover() must finish the run.
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
import type { PhaseHandler } from "../src/phases/types.js";
import { RuleBasedIntentRouter } from "../src/intent/intent-router.js";
import { SessionOrchestrator } from "../src/orchestrator/session-orchestrator.js";
import { InMemorySessionRepository } from "./helpers/in-memory-session-repository.js";
import { InMemoryMessageStore } from "./helpers/in-memory-message-store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-restart-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

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

describe("restart recovery", () => {
  it("a task killed mid-design resumes from design (not research) on the next process", async () => {
    // ---- durable layer, shared across both "processes" -----------------------
    const sessions = new InMemorySessionRepository();
    const messages = new InMemoryMessageStore();
    const artifactRepo = new InMemoryArtifactRepository();
    await sessions.create({ id: "s1", userId: "u1" });

    // ---- process #1: research completes, design hangs forever ----------------
    let signalDesignStarted!: () => void;
    const designStarted = new Promise<void>((r) => { signalDesignStarted = r; });
    const hangingDesign: PhaseHandler = {
      phase: "design" as const,
      async *run() {
        signalDesignStarted();
        await new Promise<never>(() => {}); // parked forever — the "kill" abandons it
      },
    };
    const events1 = new EventBus();
    const orch1 = new SessionOrchestrator({
      workspaces: new WorkspaceManager(root),
      events: events1,
      artifacts: new ArtifactStore(artifactRepo, events1),
      phases: new PhaseRegistry(),
      intentRouter: new RuleBasedIntentRouter(),
      handlers: new Map<PhaseId, PhaseHandler>([
        ["research", new FakePhaseHandler({ phase: "research", produce: async () => [{ kind: "brief", data: brief }] })],
        ["design", hangingDesign],
      ]),
      sessions,
      messages,
    });

    // Research parks at its asset-curation gate; approve it so the session is
    // actually IN design when the "kill" happens.
    await orch1.handleMessage("s1", {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(orch1.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" });
    // Fire and abandon — the returned promise never settles (design hangs).
    void orch1.handleMessage("s1", { text: "approve" });
    await designStarted;

    // Durable snapshot at "kill" time: new-project message done (parked at the
    // research gate), approve message processing, session running:design,
    // research's brief already persisted.
    expect(messages.all().map((r) => r.status)).toEqual(["done", "processing"]);
    expect(await sessions.get("s1")).toMatchObject({ status: "running", currentPhase: "design" });
    expect(await artifactRepo.getLatest("s1", "brief")).not.toBeNull();

    // ---- process #2: fresh instance over the same durable layer --------------
    let researchRuns2 = 0;
    const events2 = new EventBus();
    const seen2: ServerEvent[] = [];
    events2.subscribe("s1", (e) => seen2.push(e));
    const orch2 = new SessionOrchestrator({
      workspaces: new WorkspaceManager(root),
      events: events2,
      artifacts: new ArtifactStore(artifactRepo, events2),
      phases: new PhaseRegistry(),
      intentRouter: new RuleBasedIntentRouter(),
      handlers: new Map<PhaseId, PhaseHandler>([
        ["research", new FakePhaseHandler({ phase: "research", produce: async () => { researchRuns2++; return [{ kind: "brief", data: brief }]; } })],
        ["design", new FakePhaseHandler({ phase: "design", produce: async () => [{ kind: "design", data: designData }] })],
      ]),
      sessions,
      messages,
    });

    await orch2.recover();
    await vi.waitFor(() => expect(messages.all().map((r) => r.status)).toEqual(["done", "done"]));

    // Resumed from design: research did NOT re-run, design completed and gated.
    expect(researchRuns2).toBe(0);
    expect(seen2.filter((e) => e.type === "phase.started").map((e) => (e as { phase: string }).phase)).toEqual(["design"]);
    expect(orch2.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
    expect(await sessions.get("s1")).toMatchObject({ status: "awaiting-gate", currentPhase: "design" });
    expect(await artifactRepo.getLatest("s1", "design")).toMatchObject({ version: 1 });
    // The recovered run emits ordinary events — the SSE/frontend path needs nothing special.
    expect(seen2.some((e) => e.type === "gate.awaiting")).toBe(true);
  });
});
