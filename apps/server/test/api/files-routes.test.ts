// apps/server/test/api/files-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
let sessionId: string;
let storage: InMemoryStorageGateway;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-files-route-"));
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
  storage = new InMemoryStorageGateway();
  const media = new SessionMediaArchive({ storage, workspaces, sessions });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog, auth: fakeAuthService(), sessions, media };
  app = await createApp(deps);
  sessionId = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("files route", () => {
  it("serves a full file with 200 and correct Content-Length when no Range header", async () => {
    const body = Buffer.from("hello world");
    writeFileSync(join(root, sessionId, "uploads/hi.txt"), body);
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/uploads/hi.txt`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe(String(body.byteLength));
    expect(res.rawPayload).toEqual(body);
  });

  it("serves a byte range with 206 and Content-Range when Range: bytes=2-6 is sent", async () => {
    const body = Buffer.from("hello world"); // 0..10
    writeFileSync(join(root, sessionId, "uploads/hi.txt"), body);
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/uploads/hi.txt`,
      headers: { Range: "bytes=2-6" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 2-6/${body.byteLength}`);
    expect(res.headers["content-length"]).toBe("5");
    expect(res.rawPayload).toEqual(Buffer.from("llo w"));
  });

  it("handles open-ended Range: bytes=4-", async () => {
    const body = Buffer.from("hello world");
    writeFileSync(join(root, sessionId, "uploads/hi.txt"), body);
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/uploads/hi.txt`,
      headers: { Range: "bytes=4-" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 4-10/${body.byteLength}`);
    expect(res.rawPayload).toEqual(Buffer.from("o world"));
  });

  it("returns 416 when the Range is unsatisfiable", async () => {
    const body = Buffer.from("hi");
    writeFileSync(join(root, sessionId, "uploads/hi.txt"), body);
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/uploads/hi.txt`,
      headers: { Range: "bytes=100-200" },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */2`);
  });

  it("rejects path traversal (../..) with 400", async () => {
    // Use percent-encoded dots so the traversal survives WHATWG URL normalization
    // and reaches the route handler. Literal `../../` is collapsed by light-my-request
    // (Fastify's inject library uses `new URL(...)`) before routing, yielding 404 instead.
    // Percent-encoded `%2e%2e%2f` passes through and the resolve() guard catches it.
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/..%2F..%2Fetc%2Fpasswd`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 if the file does not exist inside the workspace", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/output/never.mp4`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("sets Content-Type=video/mp4 for .mp4 files", async () => {
    mkdirSync(join(root, sessionId, "output"), { recursive: true });
    writeFileSync(join(root, sessionId, "output/x.mp4"), Buffer.from("fake"));
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/output/x.mp4`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
  });

  it("sets Content-Type=text/plain for .srt files", async () => {
    mkdirSync(join(root, sessionId, "output"), { recursive: true });
    writeFileSync(join(root, sessionId, "output/subtitles.srt"), Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nHello\n"));
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/output/subtitles.srt`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it("is 404 for a session owned by another user", async () => {
    const otherApp = await createApp({ ...deps, auth: fakeAuthService({ id: "intruder", email: "i@x.com", name: "I", image: null }) });
    const res = await otherApp.inject({ method: "GET", url: `/api/sessions/${sessionId}/files/whatever.txt` });
    expect(res.statusCode).toBe(404);
    await otherApp.close();
  });
});

describe("GCS fallback", () => {
  it("302-redirects to a signed URL when the file is archived but not local", async () => {
    storage.objects.set(
      `users/u-test/sessions/${sessionId}/output/final.mp4`,
      Buffer.from("MP4"),
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/output/final.mp4`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`users/u-test/sessions/${sessionId}/output/final.mp4`);
    expect(res.headers.location).toContain("sig="); // signed URL, not a raw key path
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("404s on local miss when no media archive is configured", async () => {
    const bare = await createApp({ ...deps, media: undefined });
    try {
      const res = await bare.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/files/output/final.mp4`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });

  it("404s when the file exists neither locally nor in the bucket", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/output/nope.mp4`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("prefers the local file when present (no redirect)", async () => {
    writeFileSync(join(root, sessionId, "uploads/hi.txt"), "local");
    storage.objects.set(`users/u-test/sessions/${sessionId}/uploads/hi.txt`, Buffer.from("remote"));
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/uploads/hi.txt`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("local");
  });
});
