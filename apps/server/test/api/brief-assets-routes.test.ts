import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
  sourceAssets: { images: ["capture/assets/shot-1.png", "capture/assets/shot-2.png"], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9" as const, withVoiceover: false },
};

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let sessionId: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-brief-assets-"));
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
  await deps.workspaces.init(sessionId);
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

const patchAssets = (body: unknown, sid = sessionId) =>
  app.inject({ method: "PATCH", url: `/api/sessions/${sid}/brief/assets`, payload: body as object });

describe("PATCH /api/sessions/:sid/brief/assets", () => {
  it("removes an image and writes a new brief version with lineage", async () => {
    await deps.artifacts.put(sessionId, "brief", brief);

    const res = await patchAssets({ remove: ["capture/assets/shot-1.png"] });
    expect(res.statusCode).toBe(200);
    const env = res.json() as { version: number; data: typeof brief; derivedFrom: unknown };
    expect(env.version).toBe(2);
    expect(env.data.sourceAssets.images).toEqual(["capture/assets/shot-2.png"]);
    expect(env.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);

    const latest = await deps.artifacts.get<typeof brief>(sessionId, "brief");
    expect(latest!.data.sourceAssets.images).toEqual(["capture/assets/shot-2.png"]);
  });

  it("adds an uploaded image (deduped) after verifying the file exists", async () => {
    await deps.artifacts.put(sessionId, "brief", brief);
    const uploads = deps.workspaces.paths(sessionId).uploads;
    await writeFile(join(uploads, "better-shot.png"), Buffer.from("89504e47", "hex"));

    const res = await patchAssets({ add: ["uploads/better-shot.png", "uploads/better-shot.png"] });
    expect(res.statusCode).toBe(200);
    const env = res.json() as { data: typeof brief };
    expect(env.data.sourceAssets.images).toEqual([
      "capture/assets/shot-1.png",
      "capture/assets/shot-2.png",
      "uploads/better-shot.png",
    ]);
  });

  it("rejects adds for missing files and paths that escape the workspace", async () => {
    await deps.artifacts.put(sessionId, "brief", brief);
    expect((await patchAssets({ add: ["uploads/nope.png"] })).statusCode).toBe(400);
    expect((await patchAssets({ add: ["../outside.png"] })).statusCode).toBe(400);
    expect((await patchAssets({ add: ["/etc/passwd"] })).statusCode).toBe(400);
  });

  it("deletes the underlying file when removing an assets/ image (compose sweeps that dir)", async () => {
    const assets = deps.workspaces.paths(sessionId).assets;
    await mkdir(assets, { recursive: true });
    const file = join(assets, "generated.png");
    await writeFile(file, Buffer.from("89504e47", "hex"));
    await deps.artifacts.put(sessionId, "brief", {
      ...brief,
      sourceAssets: { ...brief.sourceAssets, images: ["assets/generated.png"] },
    });

    const res = await patchAssets({ remove: ["assets/generated.png"] });
    expect(res.statusCode).toBe(200);
    expect(existsSync(file)).toBe(false);
  });

  it("also deletes the composition-dir copy so a revision run cannot resurrect the image", async () => {
    // Compose copies brief assets next to index.html by basename; revision
    // runs list every file already in composition/ as a reusable asset. The
    // copy must go when the source image is removed.
    const paths = deps.workspaces.paths(sessionId);
    await writeFile(join(paths.composition, "shot-1.png"), Buffer.from("89504e47", "hex"));
    await deps.artifacts.put(sessionId, "brief", brief);

    const res = await patchAssets({ remove: ["capture/assets/shot-1.png"] });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(paths.composition, "shot-1.png"))).toBe(false);
  });

  it("keeps the composition copy when a kept image shares the basename", async () => {
    const paths = deps.workspaces.paths(sessionId);
    await writeFile(join(paths.composition, "shot.png"), Buffer.from("89504e47", "hex"));
    await deps.artifacts.put(sessionId, "brief", {
      ...brief,
      sourceAssets: { ...brief.sourceAssets, images: ["capture/assets/shot.png", "uploads/shot.png"] },
    });

    const res = await patchAssets({ remove: ["capture/assets/shot.png"] });
    expect(res.statusCode).toBe(200);
    // uploads/shot.png is still in the brief and owns the same basename.
    expect(existsSync(join(paths.composition, "shot.png"))).toBe(true);
  });

  it("keeps captured/uploaded files on disk when removed from the brief", async () => {
    const uploads = deps.workspaces.paths(sessionId).uploads;
    const file = join(uploads, "keep-me.png");
    await writeFile(file, Buffer.from("89504e47", "hex"));
    await deps.artifacts.put(sessionId, "brief", {
      ...brief,
      sourceAssets: { ...brief.sourceAssets, images: ["uploads/keep-me.png"] },
    });

    const res = await patchAssets({ remove: ["uploads/keep-me.png"] });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: typeof brief }).data.sourceAssets.images).toEqual([]);
    expect(existsSync(file)).toBe(true); // still re-addable
  });

  // Note: these two run in separate tests because the orchestrator caches the
  // rehydrated state after its first read — a second repo write inside the
  // same test would not be observed (prod keeps memory and repo in sync).
  it("is 409 while a phase is running", async () => {
    await deps.artifacts.put(sessionId, "brief", brief);
    await deps.sessions.updateStatus(sessionId, { status: "running", currentPhase: "design", error: null });
    expect((await patchAssets({ remove: ["capture/assets/shot-1.png"] })).statusCode).toBe(409);
  });

  it("is allowed while parked at a review gate (the intended curation moment)", async () => {
    await deps.artifacts.put(sessionId, "brief", brief);
    await deps.sessions.updateStatus(sessionId, { status: "awaiting-gate", currentPhase: "design", error: null });
    expect((await patchAssets({ remove: ["capture/assets/shot-1.png"] })).statusCode).toBe(200);
  });

  it("is 404 without a brief and 400 for an empty or malformed body", async () => {
    expect((await patchAssets({ remove: ["x.png"] })).statusCode).toBe(404);
    await deps.artifacts.put(sessionId, "brief", brief);
    expect((await patchAssets({})).statusCode).toBe(400);
    expect((await patchAssets({ add: "not-an-array" })).statusCode).toBe(400);
    expect((await patchAssets({ add: [42] })).statusCode).toBe(400);
  });

  it("is 404 for a session owned by another user", async () => {
    await deps.artifacts.put(sessionId, "brief", brief);
    const otherApp = await createApp({
      ...deps,
      auth: fakeAuthService({ id: "intruder", email: "i@x.com", name: "I", image: null }),
    });
    const res = await otherApp.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/brief/assets`,
      payload: { remove: ["capture/assets/shot-1.png"] },
    });
    expect(res.statusCode).toBe(404);
    await otherApp.close();
  });
});
