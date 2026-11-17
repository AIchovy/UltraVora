// Unit tests for SessionOrchestrator.recover() branch logic. The full
// "crash mid-phase + rebuild orchestrator" simulation lives in
// restart-recovery.test.ts; here each durable-state branch is exercised
// directly by seeding the fakes.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, PhaseId, UserMessage } from "@ultracreator/shared";
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
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-recover-")); });
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

function build() {
  const counters = { research: 0, design: 0 };
  const handlers = new Map<PhaseId, PhaseHandler>([
    ["research", new FakePhaseHandler({
      phase: "research",
      produce: async () => { counters.research++; return [{ kind: "brief", data: brief }]; },
    })],
    ["design", new FakePhaseHandler({
      phase: "design",
      produce: async () => { counters.design++; return [{ kind: "design", data: designData }]; },
    })],
  ]);
  const events = new EventBus();
  const sessions = new InMemorySessionRepository();
  const messages = new InMemoryMessageStore();
  const orch = new SessionOrchestrator({
    workspaces: new WorkspaceManager(root),
    events,
    artifacts: new ArtifactStore(new InMemoryArtifactRepository(), events),
    phases: new PhaseRegistry(),
    intentRouter: new RuleBasedIntentRouter(),
    handlers,
    sessions,
    messages,
  });
  return { orch, sessions, messages, counters };
}

// Triggers new-project from idle (the rule router requires constraints).
const newProject: UserMessage = {
  text: "Make a promo for Acme",
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

const seedRow = (
  messages: InMemoryMessageStore,
  sessionId: string,
  status: "pending" | "processing",
  payload: UserMessage,
) =>
  messages.seed({
    sessionId,
    payload,
    status,
    createdAt: new Date().toISOString(),
    startedAt: status === "processing" ? new Date().toISOString() : null,
    finishedAt: null,
  });

async function statusOf(messages: InMemoryMessageStore, id: number): Promise<string> {
  return messages.all().find((r) => r.id === id)!.status;
}

describe("SessionOrchestrator.recover", () => {
  it("replays a pending row through the normal dispatch path", async () => {
    const { orch, sessions, messages, counters } = build();
    await sessions.create({ id: "s1", userId: "u1" });
    const id = seedRow(messages, "s1", "pending", newProject);

    await orch.recover();
    await vi.waitFor(async () => expect(await statusOf(messages, id)).toBe("done"));
    expect(counters.research).toBe(1);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" });

    // approve research (asset-curation gate) → design runs and parks at its gate
    await orch.handleMessage("s1", { text: "approve" });
    expect(counters.design).toBe(1);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });

  it("processing + awaiting-gate session → marked done without re-running anything", async () => {
    const { orch, sessions, messages, counters } = build();
    await sessions.create({ id: "s1", userId: "u1" });
    await sessions.updateStatus("s1", { status: "awaiting-gate", currentPhase: "design", error: null });
    const id = seedRow(messages, "s1", "processing", { text: "anything — never dispatched" });

    await orch.recover();
    await vi.waitFor(async () => expect(await statusOf(messages, id)).toBe("done"));
    expect(counters.research).toBe(0);
    expect(counters.design).toBe(0);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });

  it("processing + error session → marked error without re-running anything", async () => {
    const { orch, sessions, messages, counters } = build();
    await sessions.create({ id: "s1", userId: "u1" });
    await sessions.updateStatus("s1", { status: "error", currentPhase: "design", error: "boom" });
    const id = seedRow(messages, "s1", "processing", { text: "anything — never dispatched" });

    await orch.recover();
    await vi.waitFor(async () => expect(await statusOf(messages, id)).toBe("error"));
    expect(counters.research).toBe(0);
    expect(counters.design).toBe(0);
  });

  it("processing + idle session (crashed before any state write) → full replay", async () => {
    const { orch, sessions, messages, counters } = build();
    await sessions.create({ id: "s1", userId: "u1" });
    const id = seedRow(messages, "s1", "processing", newProject);

    await orch.recover();
    await vi.waitFor(async () => expect(await statusOf(messages, id)).toBe("done"));
    expect(counters.research).toBe(1);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" });

    // approve research (asset-curation gate): the replayed chain continues normally
    await orch.handleMessage("s1", { text: "approve" });
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });

  it("a pending row queued behind the interrupted one runs after it, in order", async () => {
    const { orch, sessions, messages, counters } = build();
    await sessions.create({ id: "s1", userId: "u1" });
    // Interrupted new-project (idle branch → replay), a queued approve for the
    // research asset-curation gate, then a queued refine.
    const first = seedRow(messages, "s1", "processing", newProject);
    const approve = seedRow(messages, "s1", "pending", { text: "approve" });
    const second = seedRow(messages, "s1", "pending", { text: "make the palette warmer" });

    await orch.recover();
    await vi.waitFor(async () => expect(await statusOf(messages, second)).toBe("done"));
    expect(await statusOf(messages, first)).toBe("done");
    expect(await statusOf(messages, approve)).toBe("done");
    // refine re-ran design after the replayed pipeline reached the design gate
    expect(counters.research).toBe(1);
    expect(counters.design).toBe(2);
  });

  it("recover with nothing incomplete is a no-op", async () => {
    const { orch, messages, counters } = build();
    await orch.recover();
    expect(messages.all()).toHaveLength(0);
    expect(counters.research).toBe(0);
  });

  it("processing + running session whose phase has no handler → marked error, not stranded", async () => {
    const { orch, sessions, messages, counters } = build();
    await sessions.create({ id: "s1", userId: "u1" });
    // current_phase points at a phase this deployment has no handler for.
    await sessions.updateStatus("s1", { status: "running", currentPhase: "compose", error: null });
    const id = seedRow(messages, "s1", "processing", { text: "anything — resume reads state, not text" });

    await orch.recover();
    await vi.waitFor(async () => expect(await statusOf(messages, id)).toBe("error"));
    expect(counters.research).toBe(0);
    expect(counters.design).toBe(0);
  });
});
