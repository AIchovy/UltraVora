import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import type { PhaseHandler } from "../src/phases/types.js";
import { FakePhaseHandler } from "../src/phases/fake-handler.js";
import { StubTTSProvider } from "../src/providers/stub-tts.js";
import { composeOrchestrator } from "../src/compose-orchestrator.js";
import { StubRenderWorkerClient } from "../src/render/stub-render-worker.js";
import { RenderPhaseHandler } from "../src/phases/render-handler.js";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";
import { PiComposePhaseHandler } from "../src/phases/pi-compose-handler.js";
import type { QualityRunner } from "../src/render/quality-runner.js";
import { InMemorySessionRepository } from "./helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "./helpers/in-memory-message-store.js";
import { InMemoryStorageGateway } from "./helpers/in-memory-storage-gateway.js";

let root: string;
let faux: FauxProviderRegistration;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-compose-"));
  faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  faux.unregister();
});

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
};
const designData = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#000" }],
  colorRoles: { background: "#000000", foreground: "#ffffff", accent: "#ff3366" },
  typography: { heading: "A", body: "B" },
  motionStyle: "fades",
  keyVisuals: [],
  sampleFrames: [],
};
const scriptData = {
  totalSec: 30,
  scenes: [
    {
      id: "s1",
      startSec: 0,
      durationSec: 6,
      visual: "logo",
      // ~14 words ≈ 6s at the 2.4 w/s TTS budget write_script enforces.
      narration: "Meet Acme, the fastest way to ship your ideas without wrestling your own tooling.",
    },
    {
      id: "s2",
      startSec: 6,
      durationSec: 24,
      visual: "demo",
      // ~57 words ≈ 24s at 2.4 w/s.
      narration:
        "Acme connects your repos, your docs, and your deploys into one clean workflow. " +
        "Push a branch and watch previews build themselves, tests run in parallel, and " +
        "reviews land where your team already works. No more copy-pasting links, no more " +
        "waiting on stale dashboards. Just code, review, ship, and get back to building again.",
    },
  ],
};

// Minimal lint-clean composition for the REAL PiComposePhaseHandler (same
// fixture as pipeline-e2e.test.ts).
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

// Fake compose handler: produces the composition artifact AND writes index.html to
// disk (compose owns both now; the real render handler checks the file exists).
function buildFakeCompose(): PhaseHandler {
  return new FakePhaseHandler({
    phase: "compose",
    produce: async (ctx) => {
      const paths = ctx.workspaces.paths(ctx.sessionId);
      await writeFile(join(paths.composition, "index.html"), "<html>composed</html>");
      return [
        { kind: "composition", data: { dir: "composition", entry: "index.html" } },
      ];
    },
  });
}

// Plan 3's render is still a fake (Plan 4 swaps in the real RenderWorker).
// Render now only produces mp4; compose produces composition.
function buildFakeRender(): PhaseHandler {
  return new FakePhaseHandler({
    phase: "render",
    produce: async (ctx) => {
      const paths = ctx.workspaces.paths(ctx.sessionId);
      return [
        { kind: "mp4", data: { path: join(paths.output, "out.mp4") } },
      ];
    },
  });
}

describe("composeOrchestrator integration", () => {
  it("drives the full chain new-project → research (gate) → approve → design (gate) → approve → script (gate) → approve → voiceover (gate) → approve → compose → render → done", async () => {
    // Plan canned LLM responses for research, design, script — each calls the
    // appropriate write_* tool once and then says "done".
    faux.setResponses([
      // research turn 1: write_brief
      fauxAssistantMessage(fauxToolCall("write_brief", briefData)),
      // research turn 2: text "done"
      fauxAssistantMessage(fauxText("done")),
      // design turn 1: write_design
      fauxAssistantMessage(fauxToolCall("write_design", designData)),
      fauxAssistantMessage(fauxText("done")),
      // script turn 1: write_script
      fauxAssistantMessage(fauxToolCall("write_script", scriptData)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const { orchestrator, artifacts, workspaces } = composeOrchestrator({
      baseDir: root,
      model: faux.getModel("uc-test")!,
      fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) }),
      tts: new StubTTSProvider(),
      renderHandlerOverride: buildFakeRender(),
      handlerOverrides: { compose: buildFakeCompose() },
      sessions: new InMemorySessionRepository(),
      artifactRepo: new InMemoryArtifactRepository(),
      messageStore: new InMemoryMessageStore(),
    });

    // Drive: new-project → research (asset-curation gate)
    await orchestrator.handleMessage("s1", {
      text: "Make a 30-second promo for https://acme.example",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
    });
    expect(orchestrator.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" });

    // Approve research → design (gate)
    await orchestrator.handleMessage("s1", { text: "approve" });
    expect(orchestrator.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    // Approve design → script (gate)
    await orchestrator.handleMessage("s1", { text: "approve" });
    expect(orchestrator.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "script" });

    // Approve script → voiceover (gate on the generated audio)
    await orchestrator.handleMessage("s1", { text: "approve" });
    expect(orchestrator.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "voiceover" });

    // Approve voiceover → compose → render → done
    await orchestrator.handleMessage("s1", { text: "approve" });
    expect(orchestrator.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });

    // All five expected artifacts exist.
    const list = await artifacts.list("s1");
    expect(list.map((d) => d.kind).sort()).toEqual(
      ["brief", "composition", "design", "mp4", "narration", "script"].sort(),
    );
    // Narration artifact has per-scene segments and the first narrated scene's
    // audio file actually exists on disk in the composition dir.
    const compositionDir = workspaces.paths("s1").composition;
    const narrationEnv = await artifacts.get<{
      totalMs: number;
      segments: { sceneId: string; audioFile?: string; startMs: number; durationMs: number }[];
    }>("s1", "narration");
    expect(narrationEnv!.data.segments.length).toBeGreaterThan(0);
    const firstAudio = narrationEnv!.data.segments.find((s) => s.audioFile)?.audioFile;
    expect(firstAudio).toBeDefined();
    expect(existsSync(join(compositionDir, firstAudio!))).toBe(true);
  });

  it("skips voiceover when withVoiceover=false", async () => {
    const briefNoVO = {
      ...briefData,
      constraints: { ...briefData.constraints, withVoiceover: false },
    };
    const scriptNoVO = {
      ...scriptData,
      scenes: scriptData.scenes.map(({ narration: _ignored, ...rest }) => rest),
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_brief", briefNoVO)),
      fauxAssistantMessage(fauxText("done")),
      fauxAssistantMessage(fauxToolCall("write_design", designData)),
      fauxAssistantMessage(fauxText("done")),
      fauxAssistantMessage(fauxToolCall("write_script", scriptNoVO)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const { orchestrator, artifacts } = composeOrchestrator({
      baseDir: root,
      model: faux.getModel("uc-test")!,
      fetch: async () => ({ status: 200, text: "" }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) }),
      tts: new StubTTSProvider(),
      renderHandlerOverride: buildFakeRender(),
      handlerOverrides: { compose: buildFakeCompose() },
      sessions: new InMemorySessionRepository(),
      artifactRepo: new InMemoryArtifactRepository(),
      messageStore: new InMemoryMessageStore(),
    });

    await orchestrator.handleMessage("s1", {
      text: "Make a silent promo",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orchestrator.handleMessage("s1", { text: "approve" }); // approve research (asset-curation gate)
    await orchestrator.handleMessage("s1", { text: "approve" });
    await orchestrator.handleMessage("s1", { text: "approve" });

    expect(orchestrator.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });
    const list = await artifacts.list("s1");
    expect(list.find((d) => d.kind === "narration")).toBeUndefined();
    expect(list.find((d) => d.kind === "mp4")).toBeDefined();
  });

  it("drives the full chain through the REAL RenderPhaseHandler with a stub worker (produces composition + mp4 artifacts on disk)", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_brief", { ...briefData, constraints: { ...briefData.constraints, withVoiceover: false } })),
      fauxAssistantMessage(fauxText("done")),
      fauxAssistantMessage(fauxToolCall("write_design", designData)),
      fauxAssistantMessage(fauxText("done")),
      fauxAssistantMessage(fauxToolCall("write_script", scriptData)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const realRender = new RenderPhaseHandler({
      workerClient: new StubRenderWorkerClient({ writeOutput: true }),
    });

    const { orchestrator, artifacts, workspaces } = composeOrchestrator({
      baseDir: root,
      model: faux.getModel("uc-test")!,
      fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) }),
      tts: new StubTTSProvider(),
      renderHandlerOverride: realRender,
      handlerOverrides: { compose: buildFakeCompose() },
      sessions: new InMemorySessionRepository(),
      artifactRepo: new InMemoryArtifactRepository(),
      messageStore: new InMemoryMessageStore(),
    });

    await orchestrator.handleMessage("s1", {
      text: "Make a 30-second promo for https://acme.example",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orchestrator.handleMessage("s1", { text: "approve" }); // research (asset curation)
    await orchestrator.handleMessage("s1", { text: "approve" }); // design
    await orchestrator.handleMessage("s1", { text: "approve" }); // script → render → done
    expect(orchestrator.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });

    // Composition files written by the real handler.
    const compositionDir = workspaces.paths("s1").composition;
    expect(existsSync(join(compositionDir, "index.html"))).toBe(true);

    // mp4 artifact points at a real file under output/.
    const list = await artifacts.list("s1");
    const mp4 = list.find((d) => d.kind === "mp4");
    expect(mp4).toBeDefined();
    const mp4Env = await artifacts.get<{ path: string }>("s1", "mp4");
    // Stored workspace-relative; resolve against the workspace root to check disk.
    expect(mp4Env!.data.path).toMatch(/^output\/.+\.mp4$/);
    expect(existsSync(join(workspaces.paths("s1").root, mp4Env!.data.path))).toBe(true);
  });

  it("defaults render quality to high when no renderQuality option is set", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_brief", { ...briefData, constraints: { ...briefData.constraints, withVoiceover: false } })),
      fauxAssistantMessage(fauxText("done")),
      fauxAssistantMessage(fauxToolCall("write_design", designData)),
      fauxAssistantMessage(fauxText("done")),
      fauxAssistantMessage(fauxToolCall("write_script", scriptData)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    let seenQuality: string | undefined = "unset";
    const inner = new StubRenderWorkerClient({ writeOutput: true });
    const capturing: typeof inner = {
      render(opts: any) {
        seenQuality = opts.quality;
        return inner.render(opts);
      },
    } as any;

    const { orchestrator } = composeOrchestrator({
      baseDir: root,
      model: faux.getModel("uc-test")!,
      fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) }),
      tts: new StubTTSProvider(),
      renderWorkerClient: capturing,
      handlerOverrides: { compose: buildFakeCompose() },
      sessions: new InMemorySessionRepository(),
      artifactRepo: new InMemoryArtifactRepository(),
      messageStore: new InMemoryMessageStore(),
    });

    await orchestrator.handleMessage("s1", {
      text: "Make a 30-second promo for https://acme.example",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orchestrator.handleMessage("s1", { text: "approve" }); // approve research (asset-curation gate)
    await orchestrator.handleMessage("s1", { text: "approve" });
    await orchestrator.handleMessage("s1", { text: "approve" });
    expect(orchestrator.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });
    expect(seenQuality).toBe("high");
  });

  it("archives heavy media to the storage gateway after render.done", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_brief", briefData)),
      fauxAssistantMessage(fauxText("done")),
      fauxAssistantMessage(fauxToolCall("write_design", designData)),
      fauxAssistantMessage(fauxText("done")),
      fauxAssistantMessage(fauxToolCall("write_script", scriptData)),
      fauxAssistantMessage(fauxText("done")),
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: "arch-1", userId: "u-test" });
    const gateway = new InMemoryStorageGateway();
    const { orchestrator, media } = composeOrchestrator({
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
    expect(media).toBeDefined();

    await orchestrator.handleMessage("arch-1", {
      text: "Make a 30-second promo for https://acme.example",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orchestrator.handleMessage("arch-1", { text: "approve" }); // approve research (asset-curation gate)
    await orchestrator.handleMessage("arch-1", { text: "approve" });
    await orchestrator.handleMessage("arch-1", { text: "approve" });
    expect(orchestrator.getState("arch-1")).toEqual({ kind: "done", lastPhase: "render" });

    // Archive runs in the background off render.done — poll the bucket.
    await vi.waitFor(() => {
      const keys = [...gateway.objects.keys()];
      expect(keys.some((k) => /^users\/u-test\/sessions\/arch-1\/output\/.+\.mp4$/.test(k))).toBe(true);
    });

    // Quiesce: a second archiveSession enqueues FIFO behind the background one;
    // when it resolves, the first (including its unlinks) has fully finished.
    await media!.archiveSession("arch-1");
    const mp4Key = [...gateway.objects.keys()].find((k) => /output\/.+\.mp4$/.test(k))!;
    const mp4Rel = mp4Key.slice(`users/u-test/sessions/arch-1/`.length);
    expect(existsSync(join(root, "arch-1", mp4Rel))).toBe(false); // local copy deleted after verify
  });
});
