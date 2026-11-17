// The orchestrator's mid-task credit gate: a phase that can't be paid for parks
// the session in awaiting-credits (no work done, no charge), and a top-up +
// resumeCredits continues from exactly that phase, charging each phase once.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, PhaseId, ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { EventBus } from "../../src/events/event-bus.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { FakePhaseHandler } from "../../src/phases/fake-handler.js";
import type { PhaseHandler } from "../../src/phases/types.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";
import { MemoryCreditRepository } from "../../src/credits/memory-credit-repository.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-credits-"));
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

async function build(credits: MemoryCreditRepository, counters: { research: number; design: number }) {
  const sessions = new InMemorySessionRepository();
  await sessions.create({ id: "s1", userId: "s1u" });
  const messages = new InMemoryMessageStore();
  const artifactRepo = new InMemoryArtifactRepository();
  const events = new EventBus();
  const seen: ServerEvent[] = [];
  events.subscribe("s1", (e) => seen.push(e));
  const orch = new SessionOrchestrator({
    workspaces: new WorkspaceManager(root),
    events,
    artifacts: new ArtifactStore(artifactRepo, events),
    phases: new PhaseRegistry(),
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map<PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({ phase: "research", produce: async () => { counters.research++; return [{ kind: "brief", data: brief }]; } })],
      ["design", new FakePhaseHandler({ phase: "design", produce: async () => { counters.design++; return [{ kind: "design", data: designData }]; } })],
    ]),
    sessions,
    messages,
    credits,
  });
  return { orch, sessions, messages, artifactRepo, seen };
}

const newProject = {
  text: "Make a promo for Acme",
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
} as const;

describe("mid-task credit gating", () => {
  it("parks at the first phase it can't afford, doing no work and no charge", async () => {
    const credits = new MemoryCreditRepository(); // balance 0
    const counters = { research: 0, design: 0 };
    const { orch, messages, artifactRepo, seen } = await build(credits, counters);

    await orch.handleMessage("s1", newProject);

    expect(orch.getState("s1")).toEqual({ kind: "awaiting-credits", phase: "research" });
    const req = seen.find((e) => e.type === "credits.required");
    expect(req).toEqual({ type: "credits.required", phase: "research", needed: 60, balance: 0 });
    expect(counters.research).toBe(0); // handler never ran
    expect(await artifactRepo.getLatest("s1", "brief")).toBeNull();
    expect(await credits.getBalance("s1u")).toBe(0);
    expect(messages.all()[0]).toMatchObject({ status: "done" }); // parked message is complete
  });

  it("resumes from the parked phase after a top-up, then re-parks at the next unaffordable phase", async () => {
    const credits = new MemoryCreditRepository();
    const counters = { research: 0, design: 0 };
    const { orch, artifactRepo, seen } = await build(credits, counters);

    await orch.handleMessage("s1", newProject); // parks at research (needs 60, has 0)

    await credits.grant({ userId: "s1u", amount: 60, idempotencyKey: "topup1", reason: "purchase" });
    await orch.resumeCredits("s1");

    // research runs + is charged (60) and parks at its asset-curation gate.
    await vi.waitFor(() => expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" }));

    // approve research (asset-curation gate): design (needs 55) can't be paid
    // with the balance now 0 → re-parks at design without running it.
    await orch.handleMessage("s1", { text: "approve" });
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-credits", phase: "design" });

    expect(counters.research).toBe(1);
    expect(counters.design).toBe(0);
    expect(await artifactRepo.getLatest("s1", "brief")).not.toBeNull();
    expect(await artifactRepo.getLatest("s1", "design")).toBeNull();
    expect(await credits.getBalance("s1u")).toBe(0); // 60 granted, 60 charged for research

    expect(seen.filter((e) => e.type === "credits.resumed")).toHaveLength(1);
    const required = seen.filter((e) => e.type === "credits.required");
    expect(required).toEqual([
      { type: "credits.required", phase: "research", needed: 60, balance: 0 },
      { type: "credits.required", phase: "design", needed: 55, balance: 0 },
    ]);
  });
});
