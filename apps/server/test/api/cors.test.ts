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
import { createApp, type AppDeps } from "../../src/api/app.js";
import { fakeAuthService } from "../helpers/fake-auth.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";

const ALLOWED = "https://app.example.com";

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>> | undefined;

function buildDeps(r: string): AppDeps {
  const events = new EventBus();
  const workspaces = new WorkspaceManager(r);
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const phases = new PhaseRegistry();
  const sessions = new InMemorySessionRepository();
  const orchestrator = new SessionOrchestrator({
    workspaces,
    events,
    artifacts,
    phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(),
    sessions,
    messages: new InMemoryMessageStore(),
  });
  const eventLog = new SessionEventLog({ events, store: new InMemoryEventStore(), batchMs: 0 });
  return { workspaces, events, artifacts, phases, orchestrator, eventLog, auth: fakeAuthService(), sessions };
}

function preflight(from: string) {
  return app!.inject({
    method: "OPTIONS",
    url: "/api/sessions",
    headers: { origin: from, "access-control-request-method": "POST" },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-cors-"));
  deps = buildDeps(root);
  app = undefined;
});

afterEach(async () => {
  if (app) await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("CORS (cross-subdomain credentialed requests)", () => {
  it("reflects a configured web origin and allows credentials", async () => {
    app = await createApp(deps, { corsOrigin: [ALLOWED] });
    const res = await preflight(ALLOWED);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not reflect an origin outside the allowlist", async () => {
    app = await createApp(deps, { corsOrigin: [ALLOWED] });
    const res = await preflight("https://evil.example.net");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
