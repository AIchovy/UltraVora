// A throw before the first phase state-write (intent classification, project
// setup, or a credit charge that errors) must NOT leave the session silently
// "idle" — the UI reads its status off the event stream, so with no event the
// badge is stuck on "Ready" forever. The orchestrator must mark the session
// `error` and emit a `phase.error` the client can render.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, PhaseId, ServerEvent, UserMessage } from "@ultracreator/shared";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { EventBus } from "../../src/events/event-bus.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { FakePhaseHandler } from "../../src/phases/fake-handler.js";
import type { PhaseHandler } from "../../src/phases/types.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import type { IntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-errvis-"));
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

const newProject: UserMessage = {
  text: "Make a promo for Acme",
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

async function build(opts: {
  intentRouter: IntentRouter;
  handlers?: ReadonlyMap<PhaseId, PhaseHandler>;
  credits?: { debit: (...args: any[]) => Promise<any> };
}) {
  const sessions = new InMemorySessionRepository();
  await sessions.create({ id: "s1", userId: "u1" });
  const messages = new InMemoryMessageStore();
  const events = new EventBus();
  const seen: ServerEvent[] = [];
  events.subscribe("s1", (e) => seen.push(e));
  const orch = new SessionOrchestrator({
    workspaces: new WorkspaceManager(root),
    events,
    artifacts: new ArtifactStore(new InMemoryArtifactRepository(), events),
    phases: new PhaseRegistry(),
    intentRouter: opts.intentRouter,
    handlers: opts.handlers ?? new Map<PhaseId, PhaseHandler>(),
    sessions,
    messages,
    ...(opts.credits ? { credits: opts.credits } : {}),
  });
  return { orch, seen, messages };
}

describe("orchestrator error visibility", () => {
  it("marks error + emits phase.error when intent classification throws", async () => {
    const { orch, seen, messages } = await build({
      intentRouter: { classify: async () => { throw new Error("router boom"); } },
    });

    await orch.handleMessage("s1", newProject).catch(() => undefined);

    expect(orch.getState("s1").kind).toBe("error");
    expect(seen.some((e) => e.type === "phase.error" && e.phase === "research")).toBe(true);
    expect(messages.all()[0]).toMatchObject({ status: "error" });
  });

  it("marks error + emits phase.error when the per-phase charge itself throws", async () => {
    const research = new FakePhaseHandler({
      phase: "research",
      produce: async () => [{ kind: "brief", data: brief }],
    });
    const { orch, seen } = await build({
      intentRouter: new RuleBasedIntentRouter(),
      handlers: new Map<PhaseId, PhaseHandler>([["research", research]]),
      credits: { debit: async () => { throw new Error("db down"); } },
    });

    await orch.handleMessage("s1", newProject).catch(() => undefined);

    expect(orch.getState("s1").kind).toBe("error");
    expect(seen.some((e) => e.type === "phase.error" && e.phase === "research")).toBe(true);
  });
});
