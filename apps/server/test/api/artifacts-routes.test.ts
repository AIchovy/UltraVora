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

const brief = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9" as const, withVoiceover: false },
};

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let sessionId: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-art-route-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const phases = new PhaseRegistry();
  const sessions = new InMemorySessionRepository();
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts, phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(),
    sessions,
    messages: new InMemoryMessageStore(),
  });
  const eventLog = new SessionEventLog({ events, store: new InMemoryEventStore(), batchMs: 0 });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog, auth: fakeAuthService(), sessions };
  app = await createApp(deps);
  sessionId = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("artifacts routes", () => {
  it("GET /api/sessions/:sid/artifacts lists descriptors in write order", async () => {
    await deps.artifacts.put(sessionId, "brief", brief);
    await deps.artifacts.put(sessionId, "brief", { ...brief, audience: "ops" });
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/artifacts` });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ kind: string; version: number }>;
    expect(list.map((d) => ({ kind: d.kind, version: d.version }))).toEqual([
      { kind: "brief", version: 1 },
      { kind: "brief", version: 2 },
    ]);
  });

  it("GET /api/sessions/:sid/artifacts/:kind returns the latest envelope", async () => {
    await deps.artifacts.put(sessionId, "brief", brief);
    await deps.artifacts.put(sessionId, "brief", { ...brief, audience: "ops" });
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/artifacts/brief` });
    expect(res.statusCode).toBe(200);
    const env = res.json() as { version: number; data: { audience: string } };
    expect(env.version).toBe(2);
    expect(env.data.audience).toBe("ops");
  });

  it("GET /api/sessions/:sid/artifacts/:kind?version=N returns that specific version", async () => {
    await deps.artifacts.put(sessionId, "brief", brief);
    await deps.artifacts.put(sessionId, "brief", { ...brief, audience: "ops" });
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/artifacts/brief?version=1` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { version: number }).version).toBe(1);
  });

  it("GET /api/sessions/:sid/artifacts/:kind is 404 when no version exists", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/artifacts/brief` });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/sessions/:sid/artifacts/:kind is 400 for an unknown kind", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/artifacts/bogus` });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/sessions/:sid/artifacts is 404 for an unknown session", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/nope/artifacts` });
    expect(res.statusCode).toBe(404);
  });

  it("is 404 for a session owned by another user", async () => {
    const otherApp = await createApp({ ...deps, auth: fakeAuthService({ id: "intruder", email: "i@x.com", name: "I", image: null }) });
    const res = await otherApp.inject({ method: "GET", url: `/api/sessions/${sessionId}/artifacts` });
    expect(res.statusCode).toBe(404);
    await otherApp.close();
  });
});

describe("POST /api/sessions/:sid/artifacts/mp4/:version/restore", () => {
  const restore = (version: number | string) =>
    app.inject({ method: "POST", url: `/api/sessions/${sessionId}/artifacts/mp4/${version}/restore` });

  it("re-publishes an old mp4 version as the new latest, with lineage", async () => {
    await deps.artifacts.put(sessionId, "mp4", { path: "output/a.mp4" });
    await deps.artifacts.put(sessionId, "mp4", { path: "output/b.mp4" });

    const res = await restore(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ restored: true, version: 3 });

    const latest = await deps.artifacts.get<{ path: string }>(sessionId, "mp4");
    expect(latest!.version).toBe(3);
    expect(latest!.data.path).toBe("output/a.mp4");
    expect(latest!.derivedFrom).toEqual([{ kind: "mp4", version: 1 }]);
  });

  it("is a no-op when the version is already the latest", async () => {
    await deps.artifacts.put(sessionId, "mp4", { path: "output/a.mp4" });
    const res = await restore(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ restored: false, version: 1 });
    expect((await deps.artifacts.get(sessionId, "mp4"))!.version).toBe(1);
  });

  it("also restores the matching composition snapshot so later adjustments build on it", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    await deps.workspaces.init(sessionId);
    const paths = deps.workspaces.paths(sessionId);
    const comp = paths.composition;

    await deps.artifacts.put(sessionId, "composition", { dir: "composition", entry: "index.html" });
    await writeFile(join(paths.versions, "index.v1.html"), "<html>OLD</html>");
    await deps.artifacts.put(sessionId, "composition", { dir: "composition", entry: "index.html" });
    await writeFile(join(comp, "index.html"), "<html>NEW</html>");
    await deps.artifacts.put(sessionId, "mp4", { path: "output/a.mp4" }, { derivedFrom: [{ kind: "composition", version: 1 }] });
    await deps.artifacts.put(sessionId, "mp4", { path: "output/b.mp4" }, { derivedFrom: [{ kind: "composition", version: 2 }] });

    const res = await restore(1);
    expect(res.statusCode).toBe(200);

    // Disk state now matches the restored video, so a follow-up chat
    // adjustment revises THIS composition, not the newer one.
    expect(await readFile(join(comp, "index.html"), "utf8")).toBe("<html>OLD</html>");
    const latestComp = await deps.artifacts.get(sessionId, "composition");
    expect(latestComp!.version).toBe(3);
    expect(latestComp!.derivedFrom).toEqual([{ kind: "composition", version: 1 }]);
    // The snapshot invariant holds in the NEW location: the restored
    // composition version got its own snapshot in versions/.
    expect(await readFile(join(paths.versions, "index.v3.html"), "utf8")).toBe("<html>OLD</html>");
  });

  it("falls back to the legacy in-composition snapshot location (pre-versions-dir sessions)", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    await deps.workspaces.init(sessionId);
    const paths = deps.workspaces.paths(sessionId);
    const comp = paths.composition;

    await deps.artifacts.put(sessionId, "composition", { dir: "composition", entry: "index.html" });
    // Legacy deploys wrote the snapshot next to index.html.
    await writeFile(join(comp, "index.v1.html"), "<html>OLD</html>");
    await deps.artifacts.put(sessionId, "composition", { dir: "composition", entry: "index.html" });
    await writeFile(join(comp, "index.html"), "<html>NEW</html>");
    await deps.artifacts.put(sessionId, "mp4", { path: "output/a.mp4" }, { derivedFrom: [{ kind: "composition", version: 1 }] });
    await deps.artifacts.put(sessionId, "mp4", { path: "output/b.mp4" }, { derivedFrom: [{ kind: "composition", version: 2 }] });

    const res = await restore(1);
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(comp, "index.html"), "utf8")).toBe("<html>OLD</html>");
    expect((await deps.artifacts.get(sessionId, "composition"))!.version).toBe(3);
  });

  it("restores the mp4 alone when no composition snapshot exists (pre-snapshot sessions)", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    await deps.workspaces.init(sessionId);
    const comp = deps.workspaces.paths(sessionId).composition;
    await deps.artifacts.put(sessionId, "composition", { dir: "composition", entry: "index.html" });
    await deps.artifacts.put(sessionId, "composition", { dir: "composition", entry: "index.html" });
    await writeFile(join(comp, "index.html"), "<html>NEW</html>");
    await deps.artifacts.put(sessionId, "mp4", { path: "output/a.mp4" }, { derivedFrom: [{ kind: "composition", version: 1 }] });
    await deps.artifacts.put(sessionId, "mp4", { path: "output/b.mp4" }, { derivedFrom: [{ kind: "composition", version: 2 }] });

    const res = await restore(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ restored: true, version: 3 });
    expect(await readFile(join(comp, "index.html"), "utf8")).toBe("<html>NEW</html>"); // untouched
    expect((await deps.artifacts.get(sessionId, "composition"))!.version).toBe(2); // no new comp version
  });

  it("is 404 for an unknown mp4 version and 400 for a bad version param", async () => {
    await deps.artifacts.put(sessionId, "mp4", { path: "output/a.mp4" });
    expect((await restore(9)).statusCode).toBe(404);
    expect((await restore("zero")).statusCode).toBe(400);
    expect((await restore(0)).statusCode).toBe(400);
  });

  it("is 409 while a run is in flight (artifact writes belong to the orchestrator)", async () => {
    await deps.artifacts.put(sessionId, "mp4", { path: "output/a.mp4" });
    await deps.artifacts.put(sessionId, "mp4", { path: "output/b.mp4" });
    await deps.sessions.updateStatus(sessionId, { status: "running", currentPhase: "compose", error: null });
    const res = await restore(1);
    expect(res.statusCode).toBe(409);
    expect((await deps.artifacts.get(sessionId, "mp4"))!.version).toBe(2);
  });

  it("is 404 for a session owned by another user", async () => {
    await deps.artifacts.put(sessionId, "mp4", { path: "output/a.mp4" });
    const otherApp = await createApp({ ...deps, auth: fakeAuthService({ id: "intruder", email: "i@x.com", name: "I", image: null }) });
    const res = await otherApp.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/artifacts/mp4/1/restore`,
    });
    expect(res.statusCode).toBe(404);
    await otherApp.close();
  });
});
