// apps/server/test/api/sessions-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
import { InMemoryStorageGateway } from "../helpers/in-memory-storage-gateway.js";
import { SessionMediaArchive } from "../../src/storage/session-media-archive.js";

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let storage: InMemoryStorageGateway;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-sess-route-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
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
  storage = new InMemoryStorageGateway();
  const media = new SessionMediaArchive({ storage, workspaces, sessions });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog, auth: fakeAuthService(), sessions, media };
  app = await createApp(deps);
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("sessions routes", () => {
  it("POST /api/sessions returns a session id and creates the workspace dirs", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { sessionId: string };
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(join(root, body.sessionId, "uploads"))).toBe(true);
    expect(existsSync(join(root, body.sessionId, "artifacts"))).toBe(true);
    expect(existsSync(join(root, body.sessionId, "logs"))).toBe(true);
  });

  it("POST /api/sessions attaches the event log so emits get persisted", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = res.json() as { sessionId: string };
    deps.events.emit(sessionId, {
      type: "phase.progress",
      phase: "research",
      message: "hello",
    });
    await deps.eventLog.flush(sessionId);
    const persisted: string[] = [];
    for await (const e of deps.eventLog.readSince(sessionId, 0)) {
      if (e.event.type === "phase.progress") persisted.push(e.event.message);
    }
    expect(persisted).toContain("hello");
  });

  it("GET /api/sessions/:sid returns state=idle and empty artifacts for a fresh session", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: { kind: "idle" }, artifacts: [], title: null, autoApprove: false });
  });

  it("GET /api/sessions/:sid reports the durable status when not in memory (post-restart)", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    // A parked run whose in-memory orchestrator state was lost (server restart):
    // the durable row is the source of truth, so GET must not report idle.
    await deps.sessions.updateStatus(sessionId, { status: "awaiting-credits", currentPhase: "research", error: null });

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { state: unknown }).state).toEqual({ kind: "awaiting-credits", phase: "research" });
  });

  it("GET /api/sessions/:sid returns 404 for an unknown session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/sessions/:sid returns 400 for an invalid id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/has..slash" });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /api/sessions/:sid removes the workspace and closes the event log", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(204);
    expect(existsSync(join(root, sessionId))).toBe(false);
  });

  it("DELETE /api/sessions/:sid releases the orchestrator's in-memory state", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    // Drive the orchestrator's in-memory state map to a parked state for this
    // session: set the durable status, then a rehydrate (via setAutoApprove)
    // loads it into memory.
    await deps.sessions.updateStatus(sessionId, { status: "awaiting-gate", currentPhase: "design", error: null });
    await deps.orchestrator.setAutoApprove(sessionId, false);
    expect(deps.orchestrator.getState(sessionId)).toEqual({ kind: "awaiting-gate", phase: "design" });

    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(204);

    // getState reads the in-memory map (no repo rehydrate), so idle here proves
    // the DELETE handler dropped the entry rather than leaking it.
    expect(deps.orchestrator.getState(sessionId)).toEqual({ kind: "idle" });
  });

  it("DELETE /api/sessions/:sid is 404 if the session does not exist", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/sessions/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /api/sessions/:sid does not tear down other sessions' event logs", async () => {
    const a = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
    const b = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
    // emit to A so we know the listener is active
    const seenOnA: number[] = [];
    deps.eventLog.subscribe(a, (e) => seenOnA.push(e.seq));
    deps.events.emit(a, { type: "phase.progress", phase: "research", message: "1" });
    // delete B
    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${b}` });
    expect(res.statusCode).toBe(204);
    // emit again on A — A's listener should still receive it
    deps.events.emit(a, { type: "phase.progress", phase: "research", message: "2" });
    expect(seenOnA).toEqual([1, 2]);
  });

  it("returns 401 for /api/sessions* when there is no login session", async () => {
    const unauthApp = await createApp({ ...deps, auth: fakeAuthService(null) });
    const res = await unauthApp.inject({ method: "POST", url: "/api/sessions" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    await unauthApp.close();
  });

  it("leaves /api/auth/* unguarded", async () => {
    const unauthApp = await createApp({ ...deps, auth: fakeAuthService(null) });
    const res = await unauthApp.inject({ method: "GET", url: "/api/auth/ok" });
    expect(res.statusCode).toBe(200);
    await unauthApp.close();
  });

  it("guards percent-encoded paths that route to /api/sessions", async () => {
    const unauthApp = await createApp({ ...deps, auth: fakeAuthService(null) });
    const res = await unauthApp.inject({ method: "POST", url: "/api/%73essions" });
    expect(res.statusCode).toBe(401);
    await unauthApp.close();
  });

  it("POST /api/sessions persists an owned creator_sessions row", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const row = await deps.sessions.get(sessionId);
    expect(row).toMatchObject({ id: sessionId, userId: "u-test", status: "idle", title: null });
  });

  it("GET /api/sessions/:sid is 404 for a session owned by another user", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const otherApp = await createApp({ ...deps, auth: fakeAuthService({ id: "intruder", email: "i@x.com", name: "I", image: null }) });
    const res = await otherApp.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(404);
    await otherApp.close();
  });

  it("DELETE /api/sessions/:sid is 404 for a non-owner and leaves the session intact", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const otherApp = await createApp({ ...deps, auth: fakeAuthService({ id: "intruder", email: "i@x.com", name: "I", image: null }) });
    const res = await otherApp.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(404);
    await otherApp.close();
    expect(await deps.sessions.get(sessionId)).not.toBeNull();
  });

  it("DELETE /api/sessions/:sid removes the row, workspace, and event log for the owner", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(204);
    expect(existsSync(join(root, sessionId))).toBe(false);
    expect(await deps.sessions.get(sessionId)).toBeNull();
  });

  it("DELETE clears the session's GCS prefix", async () => {
    const create = await app.inject({ method: "POST", url: "/api/sessions" });
    const sid = (create.json() as { sessionId: string }).sessionId;
    storage.objects.set(`users/u-test/sessions/${sid}/output/final.mp4`, Buffer.from("MP4"));
    storage.objects.set(`users/u-test/sessions/other/output/keep.mp4`, Buffer.from("KEEP"));
    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${sid}` });
    expect(res.statusCode).toBe(204);
    expect(storage.objects.has(`users/u-test/sessions/${sid}/output/final.mp4`)).toBe(false);
    expect(storage.objects.has(`users/u-test/sessions/other/output/keep.mp4`)).toBe(true);
  });

  it("DELETE succeeds when no media archive is configured", async () => {
    const bare = await createApp({ ...deps, media: undefined });
    try {
      const create = await bare.inject({ method: "POST", url: "/api/sessions" });
      const sid = (create.json() as { sessionId: string }).sessionId;
      const res = await bare.inject({ method: "DELETE", url: `/api/sessions/${sid}` });
      expect(res.statusCode).toBe(204);
    } finally {
      await bare.close();
    }
  });

  it("guards session sub-routes when logged out", async () => {
    const unauthApp = await createApp({ ...deps, auth: fakeAuthService(null) });
    const res = await unauthApp.inject({
      method: "GET",
      url: "/api/sessions/00000000-0000-4000-8000-000000000000/stream",
    });
    expect(res.statusCode).toBe(401);
    await unauthApp.close();
  });

  it("GET /api/sessions lists only the caller's sessions, newest first", async () => {
    const a = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
    const b = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
    // Another user's session must NOT appear in u-test's list.
    const otherApp = await createApp({ ...deps, auth: fakeAuthService({ id: "other", email: "o@x.com", name: "O", image: null }) });
    await otherApp.inject({ method: "POST", url: "/api/sessions" });
    await otherApp.close();

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { id: string }[];
    expect(list.map((s) => s.id).sort()).toEqual([a, b].sort());
    expect(list.every((s) => "title" in s && "status" in s && "updatedAt" in s)).toBe(true);
  });

  it("GET /api/sessions/:sid includes the session title", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    await deps.sessions.setTitleIfEmpty(sessionId, "My Title");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect((res.json() as { title: string | null }).title).toBe("My Title");
  });

  it("GET /api/sessions is 401 when logged out", async () => {
    const unauthApp = await createApp({ ...deps, auth: fakeAuthService(null) });
    const res = await unauthApp.inject({ method: "GET", url: "/api/sessions" });
    expect(res.statusCode).toBe(401);
    await unauthApp.close();
  });

  it("POST /api/sessions stores autoApprove from the body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: { autoApprove: true } });
    expect(res.statusCode).toBe(201);
    const { sessionId } = res.json() as { sessionId: string };
    expect((await deps.sessions.get(sessionId))?.autoApprove).toBe(true);
  });

  it("POST /api/sessions defaults autoApprove to false when the body is empty", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = res.json() as { sessionId: string };
    expect((await deps.sessions.get(sessionId))?.autoApprove).toBe(false);
  });

  it("GET /api/sessions/:sid returns autoApprove", async () => {
    const { sessionId } = (
      await app.inject({ method: "POST", url: "/api/sessions", payload: { autoApprove: true } })
    ).json() as { sessionId: string };
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { autoApprove: boolean }).autoApprove).toBe(true);
  });

  it("PATCH /api/sessions/:sid updates autoApprove", async () => {
    const { sessionId } = (
      await app.inject({ method: "POST", url: "/api/sessions", payload: { autoApprove: true } })
    ).json() as { sessionId: string };
    const res = await app.inject({ method: "PATCH", url: `/api/sessions/${sessionId}`, payload: { autoApprove: false } });
    expect(res.statusCode).toBe(204);
    expect((await deps.sessions.get(sessionId))?.autoApprove).toBe(false);
  });

  it("PATCH /api/sessions/:sid 400s on an invalid body", async () => {
    const { sessionId } = (
      await app.inject({ method: "POST", url: "/api/sessions", payload: { autoApprove: true } })
    ).json() as { sessionId: string };
    const res = await app.inject({ method: "PATCH", url: `/api/sessions/${sessionId}`, payload: { autoApprove: "nope" } });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /api/sessions/:sid 404s for a non-owner", async () => {
    // Owner (u-test) creates the session.
    const { sessionId } = (
      await app.inject({ method: "POST", url: "/api/sessions", payload: { autoApprove: true } })
    ).json() as { sessionId: string };
    // A different user must not be able to PATCH it.
    const otherApp = await createApp({ ...deps, auth: fakeAuthService({ id: "intruder", email: "i@x.com", name: "I", image: null }) });
    const res = await otherApp.inject({ method: "PATCH", url: `/api/sessions/${sessionId}`, payload: { autoApprove: false } });
    expect(res.statusCode).toBe(404);
    await otherApp.close();
    // The intruder's request must not have mutated the session.
    expect((await deps.sessions.get(sessionId))?.autoApprove).toBe(true);
  });

  it("PATCH then GET reflects the updated autoApprove", async () => {
    const { sessionId } = (
      await app.inject({ method: "POST", url: "/api/sessions", payload: { autoApprove: true } })
    ).json() as { sessionId: string };
    await app.inject({ method: "PATCH", url: `/api/sessions/${sessionId}`, payload: { autoApprove: false } });
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { autoApprove: boolean }).autoApprove).toBe(false);
  });

  it("POST /api/sessions persists isPublic + productUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { autoApprove: true, isPublic: true, productUrl: "https://acme.com" },
    });
    expect(res.statusCode).toBe(201);
    const { sessionId } = res.json() as { sessionId: string };
    const row = await deps.sessions.get(sessionId);
    expect(row).toMatchObject({ isPublic: true, productUrl: "https://acme.com" });
  });

  it("POST /api/sessions rejects a malformed productUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { isPublic: true, productUrl: "not-a-url" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/sessions still works with no body (defaults private)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions" });
    expect(res.statusCode).toBe(201);
    const { sessionId } = res.json() as { sessionId: string };
    expect(await deps.sessions.get(sessionId)).toMatchObject({ isPublic: false, productUrl: null });
  });

  it("POST /api/sessions rejects a javascript: productUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { isPublic: true, productUrl: "javascript:alert(1)" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/sessions rejects a data: productUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { isPublic: true, productUrl: "data:text/html,<script>alert(1)</script>" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/sessions still accepts a normal https productUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { isPublic: true, productUrl: "https://acme.com" },
    });
    expect(res.statusCode).toBe(201);
  });
});
