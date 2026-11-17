// Phase 4 acceptance (spec §1): "删掉本地 mp4 后前端仍能播放"。
// Drives the real composed graph with faux LLM + stub renderer, then asserts
// the full archive lifecycle: render.done → background upload+verify+local
// delete → files route 302 to a signed URL → refine pulls inputs back.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { composeOrchestrator } from "../../src/compose-orchestrator.js";
import { createApp } from "../../src/api/app.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { StubTTSProvider } from "../../src/providers/stub-tts.js";
import { StubRenderWorkerClient } from "../../src/render/stub-render-worker.js";
import { PiAgentFactory } from "../../src/phases/pi-agent-factory.js";
import { PiComposePhaseHandler } from "../../src/phases/pi-compose-handler.js";
import type { QualityRunner } from "../../src/render/quality-runner.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";
import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";
import { InMemoryStorageGateway } from "../helpers/in-memory-storage-gateway.js";
import { fakeAuthService, TEST_USER } from "../helpers/fake-auth.js";

const SID = "archive-e2e";
const PREFIX = `users/${TEST_USER.id}/sessions/${SID}/`;

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#FF3366"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};
const designData = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#FF3366" }, { name: "bg", hex: "#101010" }],
  colorRoles: { background: "#101010", foreground: "#ffffff", accent: "#FF3366" },
  typography: { heading: "Poppins", body: "Inter" },
  motionStyle: "kinetic",
  keyVisuals: [],
  sampleFrames: [],
};
const scriptData = {
  totalSec: 30,
  scenes: [
    { id: "s1", startSec: 0, durationSec: 6, visual: "logo reveal", onScreenText: "Acme" },
    { id: "s2", startSec: 6, durationSec: 24, visual: "feature grid", onScreenText: "Fast" },
  ],
};

const VALID_HTML = `<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>.scene-content{width:100%;height:100%;display:flex}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="30" data-width="1920" data-height="1080">
  <div id="s1" class="clip" data-start="0" data-duration="6" data-track-index="1"><h1 class="t1">Acme</h1></div>
  <div id="s2" class="clip" data-start="6" data-duration="24" data-track-index="1"><h1 class="t2">Fast</h1></div>
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.from(".t1", { duration: 0.6, opacity: 0, y: 40 }, 0.1);
tl.from(".t2", { duration: 0.6, opacity: 0, y: 40 }, 6.1);
window.__timelines["main"] = tl;
</script></body></html>`;

const passRunner: QualityRunner = { check: async () => ({ ok: true, diagnostics: "" }) };

/**
 * One pipeline pass plus one revision pass: the later refine-at-done routes
 * to compose (revision of the existing composition) before re-rendering, so
 * the compose agent authors twice.
 */
function fauxPipelineResponses() {
  return [
    fauxAssistantMessage(fauxToolCall("write_brief", briefData)),
    fauxAssistantMessage(fauxText("done")),
    fauxAssistantMessage(fauxToolCall("write_design", designData)),
    fauxAssistantMessage(fauxText("done")),
    fauxAssistantMessage(fauxToolCall("write_script", scriptData)),
    fauxAssistantMessage(fauxText("done")),
    fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
    fauxAssistantMessage(fauxText("done")),
    // The refine's compose revision pass.
    fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
    fauxAssistantMessage(fauxText("done")),
  ];
}

let root: string;
let faux: FauxProviderRegistration;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-archive-e2e-"));
  faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  faux.unregister();
});

describe("archive lifecycle end to end", () => {
  it("archives after render.done, serves via 302, restores inputs for a re-run", async () => {
    faux.setResponses(fauxPipelineResponses());
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: SID, userId: TEST_USER.id });
    const gateway = new InMemoryStorageGateway();

    const composed = composeOrchestrator({
      baseDir: root,
      model: faux.getModel("uc-test")!,
      fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) }),
      tts: new StubTTSProvider(),
      renderWorkerClient: new StubRenderWorkerClient({ writeOutput: true }),
      composeHandlerOverride: new PiComposePhaseHandler({
        agentFactory: new PiAgentFactory({}),
        model: faux.getModel("uc-test")!,
        qualityRunner: passRunner,
      }),
      sessions,
      artifactRepo: new InMemoryArtifactRepository(),
      messageStore: new InMemoryMessageStore(),
      storageGateway: gateway,
    });
    const { orchestrator } = composed;
    const eventLog = new SessionEventLog({ events: composed.events, store: new InMemoryEventStore(), batchMs: 0 });
    const app = await createApp({ ...composed, eventLog, auth: fakeAuthService(), sessions });

    try {
      // ---- 1. Drive the pipeline to done. ----
      await orchestrator.handleMessage(SID, {
        text: "Make a 30-second promo for https://acme.example",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      });
      // Simulated user upload + downloaded asset, present before render.done.
      writeFileSync(join(root, SID, "uploads/source.pdf"), "PDF");
      writeFileSync(join(root, SID, "assets/hero.png"), "PNG");
      await orchestrator.handleMessage(SID, { text: "approve" }); // research gate (asset curation)
      await orchestrator.handleMessage(SID, { text: "approve" }); // design gate
      await orchestrator.handleMessage(SID, { text: "approve" }); // script gate
      expect(orchestrator.getState(SID)).toEqual({ kind: "done", lastPhase: "render" });

      // ---- 2. Background archive lands: bucket has the media, disk doesn't. ----
      await vi.waitFor(() => {
        const keys = [...gateway.objects.keys()];
        expect(keys.some((k) => /output\/.+\.mp4$/.test(k))).toBe(true);
        expect(keys).toContain(`${PREFIX}uploads/source.pdf`);
        expect(keys).toContain(`${PREFIX}assets/hero.png`);
      });
      // Quiesce: a second archiveSession enqueues FIFO behind the background
      // one; when it resolves, the first (including its unlinks) has finished.
      await composed.media!.archiveSession(SID);
      const mp4Key = [...gateway.objects.keys()].find((k) => /output\/.+\.mp4$/.test(k))!;
      const mp4Rel = mp4Key.slice(PREFIX.length); // output/<uuid>.mp4
      expect(existsSync(join(root, SID, mp4Rel))).toBe(false);
      expect(existsSync(join(root, SID, "uploads/source.pdf"))).toBe(false);
      expect(existsSync(join(root, SID, "assets/hero.png"))).toBe(false);
      // Composition code never leaves disk.
      expect(existsSync(join(root, SID, "composition/index.html"))).toBe(true);

      // ---- 3. Acceptance: local mp4 is gone, the files route still serves it. ----
      const res = await app.inject({ method: "GET", url: `/api/sessions/${SID}/files/${mp4Rel}` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain(mp4Key);
      expect(res.headers.location).toContain("sig=");

      // ---- 4. Re-run: refine at done revises compose + re-renders; inputs are restored first. ----
      const before = readdirSync(join(root, SID, "output")).filter((f) => f.endsWith(".mp4"));
      await orchestrator.handleMessage(SID, { text: "make the pacing snappier" });
      expect(orchestrator.getState(SID)).toEqual({ kind: "done", lastPhase: "render" });
      // restoreMissing pulled the archived inputs back before the run.
      expect(existsSync(join(root, SID, "uploads/source.pdf"))).toBe(true);
      expect(existsSync(join(root, SID, "assets/hero.png"))).toBe(true);
      // A fresh mp4 was rendered (output/ is excluded from restore).
      const after = readdirSync(join(root, SID, "output")).filter((f) => f.endsWith(".mp4"));
      expect(after.length).toBeGreaterThan(before.length);

      // Quiesce the second background archive (refine's render.done) so it
      // can't race afterEach's rmSync.
      await composed.media!.archiveSession(SID);
    } finally {
      await app.close();
      await eventLog.closeAll();
    }
  });
});
