// apps/server/test/api/uploads-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import FormData from "form-data";
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

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let sessionId: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-upload-route-"));
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

function multipartInject(files: Array<{ filename: string; content: Buffer; contentType: string }>) {
  const form = new FormData();
  for (const f of files) form.append("file", f.content, { filename: f.filename, contentType: f.contentType });
  return { payload: form.getBuffer(), headers: form.getHeaders() };
}

describe("uploads route", () => {
  it("POST /api/sessions/:sid/uploads saves one file and returns its relative path", async () => {
    const { payload, headers } = multipartInject([
      { filename: "logo.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/uploads`,
      payload, headers,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { files: { name: string; path: string }[] };
    expect(body.files).toEqual([{ name: "logo.png", path: "uploads/logo.png" }]);
    const onDisk = readFileSync(join(root, sessionId, "uploads/logo.png"));
    expect(onDisk).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("POST /api/sessions/:sid/uploads handles multiple files in one request", async () => {
    const { payload, headers } = multipartInject([
      { filename: "a.png", content: Buffer.from("a"), contentType: "image/png" },
      { filename: "b.png", content: Buffer.from("b"), contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/uploads`,
      payload, headers,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { files: { name: string; path: string }[] };
    expect(body.files.map((f) => f.name).sort()).toEqual(["a.png", "b.png"]);
    expect(existsSync(join(root, sessionId, "uploads/a.png"))).toBe(true);
    expect(existsSync(join(root, sessionId, "uploads/b.png"))).toBe(true);
  });

  it("de-duplicates two same-named files in one request into distinct paths", async () => {
    const { payload, headers } = multipartInject([
      { filename: "shot.png", content: Buffer.from("one"), contentType: "image/png" },
      { filename: "shot.png", content: Buffer.from("two"), contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/uploads`,
      payload, headers,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { files: { name: string; path: string }[] };
    const paths = body.files.map((f) => f.path);
    expect(new Set(paths).size).toBe(2); // two distinct stored paths
    expect(paths).toContain("uploads/shot.png");
    expect(paths).toContain("uploads/shot-2.png");
    expect(existsSync(join(root, sessionId, "uploads/shot.png"))).toBe(true);
    expect(existsSync(join(root, sessionId, "uploads/shot-2.png"))).toBe(true);
  });

  it("POST /api/sessions/:sid/uploads rejects a disallowed extension with 400", async () => {
    const { payload, headers } = multipartInject([
      { filename: "evil.exe", content: Buffer.from("x"), contentType: "application/octet-stream" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/uploads`,
      payload, headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/sessions/:sid/uploads is 404 for an unknown session", async () => {
    const { payload, headers } = multipartInject([
      { filename: "a.png", content: Buffer.from("a"), contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/nope/uploads`,
      payload, headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /api/sessions/:sid/uploads with no files returns 400", async () => {
    const { payload, headers } = multipartInject([]);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/uploads`,
      payload, headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it("is 404 for a session owned by another user", async () => {
    const otherApp = await createApp({ ...deps, auth: fakeAuthService({ id: "intruder", email: "i@x.com", name: "I", image: null }) });
    const res = await otherApp.inject({ method: "POST", url: `/api/sessions/${sessionId}/uploads` });
    expect(res.statusCode).toBe(404);
    await otherApp.close();
  });
});
