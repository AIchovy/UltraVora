// apps/server/test/credits/free-public-gating.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, PhaseId } from "@ultracreator/shared";
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
  root = mkdtempSync(join(tmpdir(), "uc-free-public-"));
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

function build(
  sessions: InMemorySessionRepository,
  credits: MemoryCreditRepository,
  counters: { research: number; design: number },
): SessionOrchestrator {
  const events = new EventBus();
  return new SessionOrchestrator({
    workspaces: new WorkspaceManager(root),
    events,
    artifacts: new ArtifactStore(new InMemoryArtifactRepository(), events),
    phases: new PhaseRegistry(),
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map<PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({ phase: "research", produce: async () => { counters.research++; return [{ kind: "brief", data: brief }]; } })],
      ["design", new FakePhaseHandler({ phase: "design", produce: async () => { counters.design++; return [{ kind: "design", data: designData }]; } })],
    ]),
    sessions,
    messages: new InMemoryMessageStore(),
    credits,
  });
}

const newProject = {
  text: "Make a promo for Acme",
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
} as const;

describe("free public generation", () => {
  it("runs a public session with zero balance and never charges", async () => {
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: "pub1", userId: "u1", isPublic: true });
    const credits = new MemoryCreditRepository(); // balance 0
    const debitSpy = vi.spyOn(credits, "debit");
    const counters = { research: 0, design: 0 };
    const orch = build(sessions, credits, counters);

    await orch.handleMessage("pub1", newProject);
    expect(orch.getState("pub1")).toEqual({ kind: "awaiting-gate", phase: "research" });
    await orch.handleMessage("pub1", { text: "approve" }); // approve research (asset-curation gate)

    expect(orch.getState("pub1")).toEqual({ kind: "awaiting-gate", phase: "design" });
    expect(counters).toEqual({ research: 1, design: 1 });
    expect(debitSpy).not.toHaveBeenCalled();
    expect(await sessions.hasFreePublicGrant("u1")).toBe(true);
  });

  it("charges a second public session normally once the grant is used", async () => {
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: "pub1", userId: "u1", isPublic: true });
    await sessions.claimFreePublicGrant("pub1", "u1"); // consume the one free grant
    await sessions.create({ id: "pub2", userId: "u1", isPublic: true });
    const credits = new MemoryCreditRepository(); // balance 0 → cannot pay
    const counters = { research: 0, design: 0 };
    const orch = build(sessions, credits, counters);

    await orch.handleMessage("pub2", newProject);

    expect(orch.getState("pub2")).toEqual({ kind: "awaiting-credits", phase: "research" });
    expect(counters.research).toBe(0);
  });
});
