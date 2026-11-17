// apps/server/test/api/public-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
import { InMemoryPublicVideoRepository } from "../helpers/in-memory-public-video-repository.js";
import { newSessionId } from "../../src/api/session-id.js";

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let publicVideos: InMemoryPublicVideoRepository;

function baseDeps(): AppDeps {
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const phases = new PhaseRegistry();
  const sessions = new InMemorySessionRepository();
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts, phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(), sessions, messages: new InMemoryMessageStore(),
  });
  const eventLog = new SessionEventLog({ events, store: new InMemoryEventStore(), batchMs: 0 });
  publicVideos = new InMemoryPublicVideoRepository();
  return { workspaces, events, artifacts, phases, orchestrator, eventLog, auth: fakeAuthService(), sessions, publicVideos };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-public-route-"));
  deps = baseDeps();
  app = await createApp(deps);
  publicVideos.seed({ sid: "a", title: "Alpha", author: { name: "Ann", image: null }, productUrl: "https://a.com", likeCount: 2, createdAt: "2026-01-01T00:00:00.000Z" });
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("public routes", () => {
  it("GET /api/public/videos lists videos WITHOUT auth", async () => {
    const unauth = await createApp({ ...deps, auth: fakeAuthService(null) });
    const res = await unauth.inject({ method: "GET", url: "/api/public/videos" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { sid: string }[]).map((v) => v.sid)).toEqual(["a"]);
    await unauth.close();
  });

  it("GET /api/public/videos?sort=likes passes the sort through", async () => {
    publicVideos.seed({ sid: "b", title: "Beta", author: { name: "Bo", image: null }, productUrl: null, likeCount: 9, createdAt: "2026-02-01T00:00:00.000Z" });
    const res = await app.inject({ method: "GET", url: "/api/public/videos?sort=likes" });
    expect((res.json() as { sid: string }[]).map((v) => v.sid)).toEqual(["b", "a"]);
  });

  it("GET /api/public/videos/:sid returns one, 404 for unknown", async () => {
    expect((await app.inject({ method: "GET", url: "/api/public/videos/a" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/public/videos/nope" })).statusCode).toBe(404);
  });

  it("POST like requires auth; 401 when logged out", async () => {
    const unauth = await createApp({ ...deps, auth: fakeAuthService(null) });
    expect((await unauth.inject({ method: "POST", url: "/api/public/videos/a/like" })).statusCode).toBe(401);
    await unauth.close();
  });

  it("POST then DELETE like toggles the count", async () => {
    const liked = await app.inject({ method: "POST", url: "/api/public/videos/a/like" });
    expect(liked.json()).toEqual({ likeCount: 3, liked: true });
    const unliked = await app.inject({ method: "DELETE", url: "/api/public/videos/a/like" });
    expect(unliked.json()).toEqual({ likeCount: 2, liked: false });
  });

  it("GET /:sid/video 404s for a non-public session", async () => {
    // "a" passes isValidSessionId (alphanumeric pattern); not in sessions → 404
    const res = await app.inject({ method: "GET", url: "/api/public/videos/a/video" });
    expect([404]).toContain(res.statusCode);
  });

  it("GET /:sid/video 404s for a private (non-public) done session", async () => {
    const sid = newSessionId();
    await deps.sessions.create({ id: sid, userId: "u-test", isPublic: false });
    await deps.sessions.updateStatus(sid, { status: "done", currentPhase: "render", error: null });
    await deps.workspaces.init(sid);
    const out = join(deps.workspaces.paths(sid).root, "output");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "final.mp4"), Buffer.from([0, 1, 2, 3]));
    await deps.artifacts.put(sid, "mp4", { path: "output/final.mp4" });

    const res = await app.inject({ method: "GET", url: `/api/public/videos/${sid}/video` });
    expect(res.statusCode).toBe(404);
  });

  it("GET /:sid/video streams the mp4 of a public+done session", async () => {
    const sid = newSessionId();
    await deps.sessions.create({ id: sid, userId: "u-test", isPublic: true });
    await deps.sessions.updateStatus(sid, { status: "done", currentPhase: "render", error: null });
    await deps.workspaces.init(sid);
    const out = join(deps.workspaces.paths(sid).root, "output");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "final.mp4"), Buffer.from([0, 1, 2, 3]));
    await deps.artifacts.put(sid, "mp4", { path: "output/final.mp4" });

    const res = await app.inject({ method: "GET", url: `/api/public/videos/${sid}/video` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
  });

  // Renders used to store the worker's ABSOLUTE output path in the mp4
  // artifact (new ones store a workspace-relative path). The route must keep
  // serving those legacy rows — including after the local file is archived.
  it("GET /:sid/video serves a legacy absolute artifact path from disk", async () => {
    const sid = newSessionId();
    await deps.sessions.create({ id: sid, userId: "u-test", isPublic: true });
    await deps.sessions.updateStatus(sid, { status: "done", currentPhase: "render", error: null });
    await deps.workspaces.init(sid);
    const out = join(deps.workspaces.paths(sid).root, "output");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "final.mp4"), Buffer.from([0, 1, 2, 3]));
    await deps.artifacts.put(sid, "mp4", { path: join(out, "final.mp4") });

    const res = await app.inject({ method: "GET", url: `/api/public/videos/${sid}/video` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
  });

  it("GET /:sid/video redirects a legacy absolute path to the archive once the local copy is gone", async () => {
    const sid = newSessionId();
    await deps.sessions.create({ id: sid, userId: "u-test", isPublic: true });
    await deps.sessions.updateStatus(sid, { status: "done", currentPhase: "render", error: null });
    await deps.workspaces.init(sid);
    // Archived: artifact points at the (now deleted) absolute output path.
    await deps.artifacts.put(sid, "mp4", { path: join(deps.workspaces.paths(sid).root, "output", "final.mp4") });

    const keys: string[] = [];
    const media = {
      signedUrlFor: async (_sid: string, rel: string) => {
        keys.push(rel);
        return "https://signed.example/final.mp4";
      },
    } as unknown as NonNullable<AppDeps["media"]>;
    const archived = await createApp({ ...deps, media });

    const res = await archived.inject({ method: "GET", url: `/api/public/videos/${sid}/video` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://signed.example/final.mp4");
    // The archive key must be the workspace-relative path, never the absolute one.
    expect(keys).toEqual(["output/final.mp4"]);
    await archived.close();
  });

  it("GET /:sid/video 404s when the artifact path escapes the workspace", async () => {
    const sid = newSessionId();
    await deps.sessions.create({ id: sid, userId: "u-test", isPublic: true });
    await deps.sessions.updateStatus(sid, { status: "done", currentPhase: "render", error: null });
    await deps.workspaces.init(sid);
    await deps.artifacts.put(sid, "mp4", { path: "/etc/passwd" });

    const res = await app.inject({ method: "GET", url: `/api/public/videos/${sid}/video` });
    expect(res.statusCode).toBe(404);
  });
});
