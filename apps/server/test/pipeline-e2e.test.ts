import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { composeOrchestrator } from "../src/compose-orchestrator.js";
import { StubTTSProvider } from "../src/providers/stub-tts.js";
import { InMemorySessionRepository } from "./helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "./helpers/in-memory-message-store.js";
import { StubRenderWorkerClient } from "../src/render/stub-render-worker.js";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";
import { PiComposePhaseHandler } from "../src/phases/pi-compose-handler.js";
import type { QualityRunner } from "../src/render/quality-runner.js";

let root: string;
let faux: FauxProviderRegistration;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-pipeline-"));
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

describe("full pipeline e2e (research → design → script → compose → render)", () => {
  it("authors a composition and renders an mp4 at the workspace output path", async () => {
    // Faux response queue, consumed in phase order. Voiceover is skipped
    // (withVoiceover=false) so the queue covers research/design/script/compose.
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

    const model = faux.getModel("uc-test")!;
    const { orchestrator, workspaces, artifacts } = composeOrchestrator({
      baseDir: root,
      model,
      fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) }),
      tts: new StubTTSProvider(),
      renderWorkerClient: new StubRenderWorkerClient({ writeOutput: true }),
      composeHandlerOverride: new PiComposePhaseHandler({
        agentFactory: new PiAgentFactory({}),
        model,
        qualityRunner: passRunner,
      }),
      sessions: new InMemorySessionRepository(),
      artifactRepo: new InMemoryArtifactRepository(),
      messageStore: new InMemoryMessageStore(),
    });

    await orchestrator.handleMessage("s1", {
      text: "Make a 30-second promo for https://acme.example",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(orchestrator.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" });

    await orchestrator.handleMessage("s1", { text: "approve" }); // approve research (asset-curation gate)
    expect(orchestrator.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    await orchestrator.handleMessage("s1", { text: "approve" });
    expect(orchestrator.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "script" });

    await orchestrator.handleMessage("s1", { text: "approve" });
    expect(orchestrator.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });

    // The compose phase authored a real composition on disk.
    const compEnv = await artifacts.get("s1", "composition");
    expect(compEnv).not.toBeNull();

    const html = readFileSync(join(workspaces.paths("s1").composition, "index.html"), "utf8");
    expect(html).toMatch(/data-composition-id="main"/);
    expect(html).toMatch(/window\.__timelines\["main"\]/);
    expect(html).toMatch(/gsap\.timeline\(\s*\{\s*paused:\s*true/);

    // The render phase produced an mp4 under the session output dir.
    const mp4Env = await artifacts.get<{ path: string }>("s1", "mp4");
    expect(mp4Env).not.toBeNull();
    // Stored workspace-relative under output/; resolve to check the real file.
    expect(mp4Env!.data.path).toMatch(/^output\/.+\.mp4$/);
    expect(existsSync(resolve(workspaces.paths("s1").root, mp4Env!.data.path))).toBe(true);

    // No voiceover artifact for a silent promo.
    const list = await artifacts.list("s1");
    expect(list.find((d) => d.kind === "narration")).toBeUndefined();
    expect(list.map((d) => d.kind).sort()).toEqual(
      ["brief", "composition", "design", "mp4", "script"].sort(),
    );
  });
});
