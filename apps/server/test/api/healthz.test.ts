import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { createApp, type AppDeps, type CreateAppOptions } from "../../src/api/app.js";
import { fakeAuthService } from "../helpers/fake-auth.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let eventLog: SessionEventLog;

function makeApp(opts: CreateAppOptions = {}) {
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const sessions = new InMemorySessionRepository();
  const orchestrator = new SessionOrchestrator({
    workspaces,
    events,
    artifacts,
    phases: new PhaseRegistry(),
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(),
    sessions,
    messages: new InMemoryMessageStore(),
  });
  eventLog = new SessionEventLog({ events, store: new InMemoryEventStore(), batchMs: 0 });
  const deps: AppDeps = {
    workspaces,
    events,
    artifacts,
    phases: new PhaseRegistry(),
    orchestrator,
    eventLog,
    // Logged-out auth: /healthz must not require a session.
    auth: fakeAuthService(null),
    sessions,
  };
  return createApp(deps, opts);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-healthz-"));
});
afterEach(async () => {
  await app.close();
  await eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("GET /healthz", () => {
  it("returns 200 ok without auth and without a configured check", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("runs the provided health check and returns 200 when it passes", async () => {
    const healthCheck = vi.fn().mockResolvedValue(undefined);
    app = await makeApp({ healthCheck });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when the health check fails", async () => {
    app = await makeApp({ healthCheck: () => Promise.reject(new Error("db down")) });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false });
  });
});
