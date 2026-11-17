// apps/server/test/api/end-to-end.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import FormData from "form-data";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";
import { FakePhaseHandler } from "../../src/phases/fake-handler.js";
import { createApp, type AppDeps } from "../../src/api/app.js";
import { fakeAuthService } from "../helpers/fake-auth.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";
import type { PhaseId } from "@ultracreator/shared";

const brief = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs", keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9" as const, withVoiceover: false },
};
const design = {
  mood: "energetic", palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades", keyVisuals: [], sampleFrames: [],
};
const script = { totalSec: 30, scenes: [{ id: "s1", startSec: 0, durationSec: 30, visual: "logo" }] };

async function pollUntil<T>(fn: () => Promise<T | null> | T | null, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("pollUntil timed out");
}

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let baseUrl: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-e2e-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const phases = new PhaseRegistry();
  const handlers = new Map<PhaseId, FakePhaseHandler>([
    ["research", new FakePhaseHandler({ phase: "research", produce: async () => [{ kind: "brief", data: brief }] })],
    ["design",   new FakePhaseHandler({ phase: "design",   produce: async () => [{ kind: "design", data: design }] })],
    ["script",   new FakePhaseHandler({ phase: "script",   produce: async () => [{ kind: "script", data: script }] })],
    ["compose",  new FakePhaseHandler({ phase: "compose",  produce: async () => [{ kind: "composition", data: { dir: "composition", entry: "index.html" } }] })],
    ["render",   new FakePhaseHandler({ phase: "render",   produce: async (ctx) => {
      const out = join(ctx.workspaces.paths(ctx.sessionId).output, "out.mp4");
      writeFileSync(out, Buffer.from("FAKEMP4"));
      return [
        { kind: "mp4", data: { path: out } },
      ];
    }})],
  ]);
  const sessions = new InMemorySessionRepository();
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts, phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers,
    sessions,
    messages: new InMemoryMessageStore(),
  });
  const eventLog = new SessionEventLog({ events, store: new InMemoryEventStore(), batchMs: 0 });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog, auth: fakeAuthService(), sessions };
  app = await createApp(deps);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("end-to-end HTTP happy path", () => {
  it("create session → upload → message → approve → approve → approve → render.done → fetch mp4", async () => {
    // 1. Create session.
    const create = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
    expect(create.status).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    // 2. Upload a fake asset.
    const form = new FormData();
    form.append("file", Buffer.from("png-bytes"), { filename: "logo.png", contentType: "image/png" });
    const upload = await fetch(`${baseUrl}/api/sessions/${sessionId}/uploads`, {
      method: "POST",
      body: form.getBuffer(),
      headers: form.getHeaders(),
    });
    expect(upload.status).toBe(201);

    // 3. Kick off the pipeline (parks at the research asset-curation gate).
    await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "build it",
        uploadedFiles: ["uploads/logo.png"],
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      }),
    });
    await pollUntil(async () => {
      const r = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
      if (!r.ok) return null;
      const body = (await r.json()) as { state?: { kind: string; phase?: string } };
      return body?.state?.kind === "awaiting-gate" && body?.state?.phase === "research" ? body : null;
    });

    // 3b. Approve research (asset curation).
    await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/approve" }),
    });
    await pollUntil(async () => {
      const r = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
      if (!r.ok) return null;
      const body = (await r.json()) as { state?: { kind: string; phase?: string } };
      return body?.state?.kind === "awaiting-gate" && body?.state?.phase === "design" ? body : null;
    });

    // 4. Approve design.
    await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/approve" }),
    });
    await pollUntil(async () => {
      const r = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
      if (!r.ok) return null;
      const body = (await r.json()) as { state?: { kind: string; phase?: string } };
      return body?.state?.kind === "awaiting-gate" && body?.state?.phase === "script" ? body : null;
    });

    // 5. Approve script.
    await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/approve" }),
    });
    await pollUntil(async () => {
      const r = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
      if (!r.ok) return null;
      const body = (await r.json()) as { state?: { kind: string } };
      return body?.state?.kind === "done" ? body : null;
    });

    // 6. Fetch the produced MP4 via /files.
    const mp4 = await fetch(`${baseUrl}/api/sessions/${sessionId}/files/output/out.mp4`);
    expect(mp4.status).toBe(200);
    expect(mp4.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await mp4.arrayBuffer())).toEqual(new Uint8Array(Buffer.from("FAKEMP4")));

    // 7. The session has the full artifact set.
    const list = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`)).json()) as Array<{ kind: string }>;
    expect(list.map((d) => d.kind).sort()).toEqual(["brief", "composition", "design", "mp4", "script"]);
  }, 10_000);
});
