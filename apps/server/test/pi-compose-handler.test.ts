import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The real vendored hyperframes SKILL.md, resolved from this test's location
// (apps/server/test → ../src/skills/vendor/...).
const HYPERFRAMES_SKILL_MD = fileURLToPath(
  new URL("../src/skills/vendor/hyperframes/hyperframes/SKILL.md", import.meta.url),
);
import {
  registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall,
} from "@earendil-works/pi-ai/compat";
import sharp from "sharp";
import type { Brief, Design, Script, ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";
import {
  PiComposePhaseHandler, subtitlesBlockFor, bgmBlockFor, formatAssetsBlock,
  filterDesignToAvailableAssets, SYSTEM_PROMPT,
} from "../src/phases/pi-compose-handler.js";
import { HyperframesQualityRunner, type QualityRunner } from "../src/render/quality-runner.js";

describe("bgmBlockFor", () => {
  it("returns a background-music instruction when bgm is true", () => {
    const block = bgmBlockFor({ bgm: true });
    expect(block).toMatch(/music|bgm/i);
    expect(block).toMatch(/generate_music/);
    expect(block.length).toBeGreaterThan(0);
  });

  it("returns empty string when bgm is false or omitted", () => {
    expect(bgmBlockFor({ bgm: false })).toBe("");
    expect(bgmBlockFor({})).toBe("");
  });
});

describe("subtitlesBlockFor", () => {
  it("returns empty string even when subtitles is true (subtitles are now a separate SRT artifact, not burned in)", () => {
    expect(subtitlesBlockFor({ subtitles: true })).toBe("");
  });

  it("returns empty string when subtitles is false or omitted", () => {
    expect(subtitlesBlockFor({ subtitles: false })).toBe("");
    expect(subtitlesBlockFor({})).toBe("");
  });
});

describe("compose SYSTEM_PROMPT — black-scene prevention", () => {
  // Regression guard for the "black first/last scene" bug: a scene revealed with
  // `tl.set(autoAlpha:1)` at timeline position 0 collides with a global hide-all
  // `tl.set(".scene", {autoAlpha:0})` (also at 0); the reveal is dropped when the runtime
  // stretches the timeline to data-duration, so the scene renders pure black for its whole
  // window. The prompt must steer the author to an immediate gsap.set() for the initial
  // hidden state and away from a position-0 hide-all.
  it("tells the author to set the initial hidden state with an immediate gsap.set", () => {
    expect(SYSTEM_PROMPT).toContain('gsap.set(".scene"');
  });

  it("warns that a hide-all tl.set at timeline position 0 causes a black scene", () => {
    expect(SYSTEM_PROMPT).toMatch(/position 0/);
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("hide-all");
  });

  // Regression guard for the layout-collapse black scene (session 9ffaa12e): a grid/flex
  // scene inherits the base `.scene` rule's `align-items:center`, which sizes each cell to
  // its content. A cell whose only content is a background-image (label child is
  // position:absolute, adding no height) collapses to height 0, so the image never shows and
  // the scene renders black. The prompt must steer the author to align-items:stretch + a
  // definite cell height.
  it("warns that grid/flex cells with only a background-image collapse to 0 height and render black", () => {
    const lower = SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("align-items");
    expect(lower).toMatch(/align-items\s*:?\s*stretch/);
    expect(lower).toContain("collapse");
  });
});

describe("compose SYSTEM_PROMPT — image sizing", () => {
  // Regression guard for the overflowing-logo bug (session e871ba4d): a 936×168
  // lockup sized height:400px renders ~2229px wide and hangs off a 1920px frame.
  // The prompt must point the author at the listed pixel dimensions and steer
  // wide assets toward width-based sizing with a max-width guard.
  it("tells the author the asset list carries true pixel dimensions", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("pixel dimensions");
  });

  it("warns against sizing an image by height alone and prescribes width + max-width", () => {
    const lower = SYSTEM_PROMPT.toLowerCase();
    expect(lower).toMatch(/height\s*:\s*auto/);
    expect(lower).toContain("max-width");
    expect(lower).toMatch(/height alone/);
  });

  it("says the inspector also fails non-text elements that overflow", () => {
    expect(SYSTEM_PROMPT).toMatch(/image[^.]*overflow|overflow[^.]*image/i);
  });
});

describe("compose SYSTEM_PROMPT — hold-period ambient motion", () => {
  // Regression guard for the frozen-scene bug (prod session 45a7b61e): every
  // scene had a 1-2s entrance then a completely static frame for the remaining
  // 6s of its window. The prompt must demand ambient motion spanning each
  // scene's FULL duration, and must teach the lint-legal loop recipe — the
  // model writes repeat:-1, lint rejects it, and its cheapest "fix" is deleting
  // the ambient loop entirely.
  it("requires ambient motion spanning the scene's full window after the entrance", () => {
    const lower = SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("ambient");
    expect(lower).toMatch(/freeze|frozen|static/);
    expect(lower).toMatch(/full (remaining window|window|duration)/);
    expect(lower).toContain("ken burns");
  });

  it("teaches the finite repeat + yoyo recipe instead of the lint-banned repeat:-1", () => {
    expect(SYSTEM_PROMPT).toMatch(/repeat:\s*-1/);
    expect(SYSTEM_PROMPT).toContain("yoyo");
    expect(SYSTEM_PROMPT).toMatch(/sine\.inOut/);
  });

  it("demands the motion be visibly large, not a subtle blur drift", () => {
    const lower = SYSTEM_PROMPT.toLowerCase();
    expect(lower).toMatch(/visible/);
    expect(lower).toMatch(/\d+\s*%/);
  });

  // Regression guard for the gate ping-pong (prod session 15796467): the model
  // satisfied the ambient rule by scaling the full-frame .content-layer, which
  // overflowed the scene clip by >12px and failed the overflow inspection;
  // fixing one gate re-broke the other until the round budget ran out. The
  // prompt must name safe ambient targets and the intentional-bleed escape.
  it("bans ambient scale/drift on the scene container or full-frame wrappers", () => {
    const lower = SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("full-frame content wrapper");
    expect(lower).toMatch(/never scale/i);
  });

  it("offers data-layout-allow-overflow for intentional full-bleed Ken Burns", () => {
    expect(SYSTEM_PROMPT).toContain("data-layout-allow-overflow");
  });
});

describe("compose SYSTEM_PROMPT — transition coverage", () => {
  // Regression guard for the black-band transition artifact (prod session
  // 45a7b61e @16.6s): the incoming scene slid in for 1s but the outgoing
  // scene's clip window ended 0.5s into the slide, exposing the page
  // background as a black band on the uncovered side.
  it("requires the outgoing scene to stay visible for the whole container transition", () => {
    const lower = SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("outgoing scene");
    expect(lower).toMatch(/black band/);
  });
});

describe("compose SYSTEM_PROMPT — decorative bleed clipping", () => {
  // Regression guard for the prod compose failure of 2026-07-09: corner
  // decoratives hanging past the scene's bottom/right edge inflate the scene's
  // scrollWidth, and the inspector reports a bogus full-frame clipped_text on
  // the scene mid-wipe. The contract must prescribe the clip-layer pattern so
  // compositions never author the hazard in the first place.
  it("prescribes a full-size overflow:hidden clip layer for bleeding decoratives", () => {
    const lower = SYSTEM_PROMPT.toLowerCase();
    expect(lower).toMatch(/inset:\s*0/);
    expect(lower).toMatch(/overflow:\s*hidden/);
    expect(lower).toMatch(/scrollwidth|scroll box/);
  });
});

describe("filterDesignToAvailableAssets", () => {
  // The user curates the brief's source images at review gates, but the design
  // artifact is not rewritten — its keyVisuals/sampleFrames may still point at
  // deleted assets. Feeding those refs to compose reads as "embed this file",
  // the file was never copied next to index.html, and validation bounces the
  // 404 (prod session feedback 2026-08-06).
  const design: Design = {
    mood: "calm",
    palette: [{ name: "p", hex: "#111111" }],
    typography: { heading: "Geist", body: "Geist Mono" },
    motionStyle: "steady",
    keyVisuals: [
      { description: "kept visual", refAssetId: "capture/assets/kept.png" },
      { description: "deleted visual", refAssetId: "capture/assets/gone.png" },
      { description: "prose-only directive" },
      { description: "remote ref", refAssetId: "https://cdn.example/x.png" },
    ],
    sampleFrames: [
      { caption: "kept frame", layoutHint: "center", thumbnailUrl: "capture/assets/kept.png" },
      { caption: "frame with dead thumb", layoutHint: "split", thumbnailUrl: "assets/gone-gen.png" },
    ],
  };
  const available = [{ name: "kept.png", role: "image" }];

  it("drops keyVisuals whose asset no longer exists; keeps prose-only and remote refs", () => {
    const out = filterDesignToAvailableAssets(design, available);
    expect(out.keyVisuals.map((v) => v.description)).toEqual([
      "kept visual",
      "prose-only directive",
      "remote ref",
    ]);
  });

  it("strips dead sampleFrame thumbnails but keeps the frame's creative directive", () => {
    const out = filterDesignToAvailableAssets(design, available);
    expect(out.sampleFrames).toEqual([
      { caption: "kept frame", layoutHint: "center", thumbnailUrl: "capture/assets/kept.png" },
      { caption: "frame with dead thumb", layoutHint: "split" },
    ]);
  });

  it("does not mutate the input design", () => {
    filterDesignToAvailableAssets(design, available);
    expect(design.keyVisuals).toHaveLength(4);
    expect(design.sampleFrames[1]!.thumbnailUrl).toBe("assets/gone-gen.png");
  });
});

describe("formatAssetsBlock", () => {
  it("lists role and pixel dimensions when known", () => {
    const block = formatAssetsBlock([
      { name: "logo.png", role: "logo", dimensions: { width: 936, height: 168 } },
    ]);
    expect(block).toBe("- logo.png (logo, 936×168px)");
  });

  it("omits dimensions for assets that could not be probed", () => {
    const block = formatAssetsBlock([{ name: "gen.png", role: "image" }]);
    expect(block).toBe("- gen.png (image)");
  });

  it("keeps the no-assets fallback line", () => {
    expect(formatAssetsBlock([])).toContain("none downloaded");
  });
});

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-comp-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const brief: Brief = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs", keyMessages: ["fast"],
  brandHints: { colors: ["#FF3366"], logoFile: "assets/logo.png" },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 15, aspectRatio: "16:9", withVoiceover: false },
};
const design: Design = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#FF3366" }, { name: "bg", hex: "#101010" }],
  typography: { heading: "Poppins", body: "Inter" },
  motionStyle: "kinetic", keyVisuals: [], sampleFrames: [],
};
const script: Script = {
  totalSec: 12,
  scenes: [
    { id: "s1", startSec: 0, durationSec: 6, visual: "logo reveal", onScreenText: "Acme" },
    { id: "s2", startSec: 6, durationSec: 6, visual: "feature grid", onScreenText: "Fast" },
  ],
};

const VALID_HTML = `<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>.scene-content{width:100%;height:100%;display:flex}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="12" data-width="1920" data-height="1080">
  <div id="s1" class="clip" data-start="0" data-duration="6" data-track-index="1"><h1 class="t1">Acme</h1></div>
  <div id="s2" class="clip" data-start="6" data-duration="6" data-track-index="1"><h1 class="t2">Fast</h1></div>
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.from(".t1", { duration: 0.6, opacity: 0, y: 40 }, 0.1);
tl.from(".t2", { duration: 0.6, opacity: 0, y: 40 }, 6.1);
window.__timelines["main"] = tl;
</script></body></html>`;

function seedAssets(wm: WorkspaceManager) {
  return writeFile(join(wm.paths("s1").assets, "logo.png"), Buffer.from("89504e47", "hex"));
}

async function seed(store: ArtifactStore, wm: WorkspaceManager) {
  await wm.init("s1");
  await seedAssets(wm);
  await store.put("s1", "brief", brief);
  await store.put("s1", "design", design);
  await store.put("s1", "script", script);
}

const passRunner: QualityRunner = { check: async () => ({ ok: true, diagnostics: "" }) };

function fauxAuthoring() {
  const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
    fauxAssistantMessage(fauxText("done")),
  ]);
  return faux;
}

describe("PiComposePhaseHandler", () => {
  it("authors a composition, copies assets, writes the composition artifact", async () => {
    const faux = fauxAuthoring();
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });

    const yielded: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) yielded.push(e);

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();

    const htmlPath = join(wm.paths("s1").composition, "index.html");
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toMatch(/data-composition-id="main"/);
    expect(html).toMatch(/data-width="1920"[\s\S]*data-height="1080"[\s\S]*data-duration="12"|data-duration="12"[\s\S]*data-width="1920"/);
    expect(html).toMatch(/data-start="0"[\s\S]*data-duration="6"/);
    expect(html).toMatch(/window\.__timelines\["main"\]/);
    const tweenCount = (html.match(/tl\.from\(/g) ?? []).length;
    expect(tweenCount).toBeGreaterThanOrEqual(script.scenes.length);

    expect(existsSync(join(wm.paths("s1").composition, "logo.png"))).toBe(true);

    // Per-version snapshot: the restore endpoint copies index.v<N>.html back
    // to index.html when the user reverts to an older video version. It lives
    // in versions/ (outside the composition root) so the renderer never sees
    // two root compositions (multiple_root_compositions lint).
    expect(readFileSync(join(wm.paths("s1").versions, "index.v1.html"), "utf8")).toBe(html);
    expect(existsSync(join(wm.paths("s1").composition, "index.v1.html"))).toBe(false);
  });

  it("migrates legacy in-composition snapshots to versions/ (pre-versions-dir sessions)", async () => {
    const faux = fauxAuthoring();
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);
    // A pre-versions-dir session: composition v1 exists in the store and its
    // snapshot sits next to index.html, where it trips the renderer's
    // multiple_root_compositions lint until moved.
    await store.put("s1", "composition", { dir: "composition", entry: "index.html" });
    await writeFile(join(wm.paths("s1").composition, "index.v1.html"), "<html>legacy</html>");

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    // The legacy snapshot moved out of the composition dir intact…
    expect(existsSync(join(wm.paths("s1").composition, "index.v1.html"))).toBe(false);
    expect(readFileSync(join(wm.paths("s1").versions, "index.v1.html"), "utf8")).toBe("<html>legacy</html>");
    // …and this run's own snapshot landed beside it as v2.
    expect(existsSync(join(wm.paths("s1").versions, "index.v2.html"))).toBe(true);
  });

  it("recovers from a transient fetch-failed turn and still authors the composition (prod session 238388c4 regression)", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "fetch failed" }),
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
      retry: { baseDelayMs: 1 },
    });

    const yielded: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) yielded.push(e);

    expect(
      yielded.some((e) => e.type === "phase.progress" && /Transient error/.test((e as any).message)),
    ).toBe(true);
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
    expect(existsSync(join(wm.paths("s1").composition, "index.html"))).toBe(true);
  });

  it("lists probed pixel dimensions for real image assets in the agent prompt", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    let seenPrompt = "";
    faux.setResponses([
      (context) => {
        seenPrompt = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML }),
        );
      },
      fauxAssistantMessage(fauxText("done")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await wm.init("s1");
    // A real 936×168 PNG (the e871ba4d logo shape) instead of seedAssets' magic bytes.
    await sharp({
      create: { width: 936, height: 168, channels: 3, background: { r: 250, g: 210, b: 70 } },
    })
      .png()
      .toFile(join(wm.paths("s1").assets, "logo.png"));
    await store.put("s1", "brief", brief);
    await store.put("s1", "design", design);
    await store.put("s1", "script", script);

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(seenPrompt).toContain("logo.png (logo, 936×168px)");
  });

  it("runs one blank-frame round when a scene renders black", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    let blankPrompt = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
      fauxAssistantMessage(fauxText("authored")),
      (context) => {
        const msgs = (context.messages as any[]).filter((m) => m.role === "user");
        blankPrompt = JSON.stringify(msgs[msgs.length - 1]?.content ?? "");
        return fauxAssistantMessage(
          fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML }),
        );
      },
      fauxAssistantMessage(fauxText("fixed")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);

    let calls = 0;
    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
      blankFrameCheck: async () => {
        calls++;
        return calls === 1 ? ["Frame at t=3s (scene #s1) renders nearly black"] : [];
      },
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(calls).toBe(1); // single pass — the fix is trusted, no re-probe loop
    expect(blankPrompt).toContain("scene #s1");
    expect(blankPrompt).toMatch(/BLACK/);
  });

  it("frame-check fix round does not consume the geometry round budget (prod session 15796467)", async () => {
    // Geometry uses rounds 1..N BEFORE the frame check; the frame fix then
    // introduces a fresh layout error. The session must still have geometry
    // budget to correct it instead of hard-failing.
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses(
      Array.from({ length: 4 }, () => [
        fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
        fauxAssistantMessage(fauxText("done")),
      ]).flat(),
    );
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);

    // check #1 fail (geometry round 1 of 2) → #2 ok (frame check flags, fix does
    // NOT count) → #3 fail (post-frame-fix regression, round 2 of 2) → #4 ok.
    let checks = 0;
    const runner: QualityRunner = {
      check: async () => {
        checks++;
        return checks % 2 === 1
          ? { ok: false, diagnostics: "element overflow" }
          : { ok: true, diagnostics: "" };
      },
    };
    let frameChecks = 0;
    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: runner,
      maxRounds: 2,
      blankFrameCheck: async () => {
        frameChecks++;
        return frameChecks === 1 ? ["Scene #s1 shows no visible motion"] : [];
      },
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(checks).toBe(4);
    expect(frameChecks).toBe(1); // still single-pass
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
  });

  it("runs one design-fidelity round when the composition invents off-palette colors", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    const offPaletteHtml = VALID_HTML.replace(
      "<h1 class=\"t1\">Acme</h1>",
      `<h1 class="t1" style="color:#4ECDC4">Acme</h1>`,
    );
    let fidelityPrompt = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: offPaletteHtml })),
      fauxAssistantMessage(fauxText("authored")),
      // Fidelity re-prompt lands here: capture it, then fix the color.
      (context) => {
        const msgs = (context.messages as any[]).filter((m) => m.role === "user");
        fidelityPrompt = JSON.stringify(msgs[msgs.length - 1]?.content ?? "");
        return fauxAssistantMessage(
          fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML }),
        );
      },
      fauxAssistantMessage(fauxText("fixed")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(fidelityPrompt).toContain("#4ecdc4");
    expect(fidelityPrompt).toMatch(/DESIGN contract/);
    // The fixed composition (no invented color) was persisted.
    const html = await (await import("node:fs/promises")).readFile(
      join(wm.paths("s1").composition, "index.html"), "utf8");
    expect(html).not.toContain("#4ECDC4");
  });

  it("gives the compose agent the brief's product, audience, copy and styleIntent", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    let seenPrompt = "";
    faux.setResponses([
      (context) => {
        seenPrompt = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML }),
        );
      },
      fauxAssistantMessage(fauxText("done")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await wm.init("s1");
    await seedAssets(wm);
    await store.put("s1", "brief", {
      ...brief,
      sourceAssets: { images: [], videos: [], copy: ["Ship 10x faster", "Loved by 20k teams"] },
      styleIntent: "like an Apple ad, minimal",
    });
    await store.put("s1", "design", design);
    await store.put("s1", "script", script);

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(seenPrompt).toContain("Do more"); // product tagline
    expect(seenPrompt).toContain("devs"); // audience
    expect(seenPrompt).toContain("Ship 10x faster"); // source copy
    expect(seenPrompt).toContain("like an Apple ad"); // styleIntent
  });

  it("marks near-blank swept assets as decorative-only in the asset list", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    let seenPrompt = "";
    faux.setResponses([
      (context) => {
        seenPrompt = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML }),
        );
      },
      fauxAssistantMessage(fauxText("done")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);
    // A big flat gradient-ish image: compresses to almost nothing per pixel —
    // the research phase would have rejected it, but it sits in assets/ and
    // the sweep picks it up.
    await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: { r: 255, g: 211, b: 71 } },
    }).webp().toFile(join(wm.paths("s1").assets, "banner.webp"));

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(seenPrompt).toMatch(/banner\.webp \(decorative-only/);
  });

  it("sweeps generated images in assets/ into composition/ even when unreferenced by the brief", async () => {
    const faux = fauxAuthoring();
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm); // brief refs only assets/logo.png
    // Simulate an image the design phase generated via generate_image: it lives
    // in assets/ but is not listed in the brief's logoFile / sourceAssets.
    await writeFile(join(wm.paths("s1").assets, "generated-xyz.png"), Buffer.from("89504e47", "hex"));

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(existsSync(join(wm.paths("s1").composition, "generated-xyz.png"))).toBe(true);
  });

  it("authors the composition when a per-scene narration timeline is present", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm); // brief/design/script + logo asset

    const comp = wm.paths("s1").composition;
    await writeFile(join(comp, "narration-s1.wav"), Buffer.from("RIFF", "ascii"));
    await writeFile(join(comp, "narration-s2.wav"), Buffer.from("RIFF", "ascii"));
    await store.put("s1", "narration", {
      totalMs: 12000,
      segments: [
        { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 6000 },
        { sceneId: "s2", audioFile: "narration-s2.wav", startMs: 6000, durationMs: 6000 },
      ],
    });

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
    expect(existsSync(join(comp, "narration-s1.wav"))).toBe(true);
    expect(existsSync(join(comp, "narration-s2.wav"))).toBe(true);
  });

  it("feeds the agent script scenes retimed to the narration timeline, not the stale plan", async () => {
    // Prod session 45a7b61e: the prompt carried the script's planned 6s next to
    // the narration block's authoritative 7.91s for the same scene; motion
    // authored to 6s left a 2s frozen tail. The scenes JSON must carry the
    // narration timings.
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    let seenPrompt = "";
    const retimedHtml = VALID_HTML
      .replace('data-duration="12" data-width', 'data-duration="15.24" data-width')
      .replace('id="s1" class="clip" data-start="0" data-duration="6"', 'id="s1" class="clip" data-start="0" data-duration="7.33"')
      .replace('id="s2" class="clip" data-start="6" data-duration="6"', 'id="s2" class="clip" data-start="7.33" data-duration="7.91"');
    faux.setResponses([
      (context) => {
        seenPrompt = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          fauxToolCall("write_composition_file", { path: "index.html", content: retimedHtml }),
        );
      },
      fauxAssistantMessage(fauxText("done")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm); // script plans 6s + 6s
    await store.put("s1", "narration", {
      totalMs: 15240,
      segments: [
        { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 7330 },
        { sceneId: "s2", audioFile: "narration-s2.wav", startMs: 7330, durationMs: 7910 },
      ],
    });

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    // Scenes JSON carries the final (stretched) timings…
    expect(seenPrompt).toContain("7.33");
    expect(seenPrompt).toContain("7.91");
    // …and no longer the stale planned durations (JSON-encoded prompt string).
    expect(seenPrompt).not.toContain('durationSec\\": 6');
  });

  it("refuses to copy an asset whose ref escapes the workspace", async () => {
    const faux = fauxAuthoring();
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await wm.init("s1");
    // A sentinel file outside the workspace the traversal ref would point at.
    const outside = join(root, "secret.png");
    await writeFile(outside, Buffer.from("89504e47", "hex"));
    await store.put("s1", "brief", {
      ...brief,
      brandHints: { ...brief.brandHints, logoFile: "../secret.png" },
    });
    await store.put("s1", "design", design);
    await store.put("s1", "script", script);

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(existsSync(join(wm.paths("s1").composition, "secret.png"))).toBe(false);
  });

  it("re-prompts the agent with diagnostics on failure, then converges", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: "<html>bad</html>" })),
      fauxAssistantMessage(fauxText("done")),
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
      fauxAssistantMessage(fauxText("fixed")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);

    let calls = 0;
    const flakyRunner: QualityRunner = {
      check: async () => (++calls === 1 ? { ok: false, diagnostics: "missing data-composition-id" } : { ok: true, diagnostics: "" }),
    };

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: flakyRunner,
    });

    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(calls).toBe(2);
    const html = readFileSync(join(wm.paths("s1").composition, "index.html"), "utf8");
    expect(html).toMatch(/data-composition-id="main"/);
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
  });

  it("repairs authored emoji through the quality loop before saving a composition", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    let repairPrompt = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: '<div>🎯 Product benefits</div>' })),
      fauxAssistantMessage(fauxText("done")),
      (context) => {
        repairPrompt = JSON.stringify(context.messages.at(-1)?.content);
        return fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML }));
      },
      fauxAssistantMessage(fauxText("fixed")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);
    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: new HyperframesQualityRunner({ commandFor: () => ["node", "-e", "process.exit(0)"] }),
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }
    expect(repairPrompt).toContain("[iconography]");
    expect(repairPrompt).toContain("SVG paths");
    expect(await store.get("s1", "composition")).not.toBeNull();
    expect(readFileSync(join(wm.paths("s1").composition, "index.html"), "utf8")).not.toContain("🎯");
  });

  it("emits phase.error and throws after exhausting the round budget", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    // 4 authoring passes (1 initial + 3 fix rounds), each a tool call then a
    // turn-ending text message so the agent's prompt() resolves each pass.
    faux.setResponses(
      Array.from({ length: 6 }, () => [
        fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: "<html>bad</html>" })),
        fauxAssistantMessage(fauxText("done")),
      ]).flat(),
    );
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);

    const failRunner: QualityRunner = { check: async () => ({ ok: false, diagnostics: "still broken" }) };
    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: failRunner,
      maxRounds: 3,
    });

    const yielded: ServerEvent[] = [];
    await expect(async () => {
      for await (const e of handler.run({
        sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
        signal: new AbortController().signal,
      } as any)) yielded.push(e);
    }).rejects.toThrow(/quality|validation/i);

    expect(yielded.some((e) => e.type === "phase.error")).toBe(true);
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeUndefined();
  });

  it("exposes read_skill_file and still authors the composition", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_skill_file", { path: HYPERFRAMES_SKILL_MD })),
      fauxAssistantMessage(fauxText("got it")),
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    const yielded: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) yielded.push(e);

    const toolEnds = yielded.filter(
      (e): e is Extract<ServerEvent, { type: "agent.tool_end" }> => e.type === "agent.tool_end",
    );
    expect(toolEnds.some((e) => e.toolName === "read_skill_file" && !e.isError)).toBe(true);

    // The activity feed no longer carries redundant per-tool / per-turn progress noise;
    // the structured tool events above are what convey the run.
    const messages = yielded
      .filter((e) => e.type === "phase.progress")
      .map((e) => (e as { message: string }).message);
    expect(messages).not.toContain("Tool read_skill_file completed.");
    expect(messages).not.toContain("Turn complete.");
    expect(messages.some((m) => m.startsWith("Running tool:"))).toBe(false);

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
  });

  it("installs a registry block via add_registry_item, then authors the composition", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("add_registry_item", { name: "macos-notification" })),
      fauxAssistantMessage(fauxText("installed")),
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    const yielded: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) yielded.push(e);

    // The block's files were copied into the composition dir by the tool.
    expect(existsSync(join(wm.paths("s1").composition, "macos-notification.html"))).toBe(true);
    const toolEnds = yielded.filter(
      (e): e is Extract<ServerEvent, { type: "agent.tool_end" }> => e.type === "agent.tool_end",
    );
    expect(toolEnds.some((e) => e.toolName === "add_registry_item" && !e.isError)).toBe(true);

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
  });

  it("revises the existing composition when a refinement is present: prompt carries the current html + the request", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    let seenPrompt = "";
    faux.setResponses([
      (context) => {
        seenPrompt = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML }),
        );
      },
      fauxAssistantMessage(fauxText("done")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);
    // The previous run's composition + a generated asset it references.
    const PREVIOUS_HTML = VALID_HTML.replace("Acme", "AcmeOld");
    await writeFile(join(wm.paths("s1").composition, "index.html"), PREVIOUS_HTML);
    await writeFile(join(wm.paths("s1").composition, "bg-texture.png"), Buffer.from("89504e47", "hex"));

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      refinement: "make the headline blue",
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    // The revision prompt must carry the user's request, the current html, and
    // a targeted-edit instruction (not a from-scratch re-author).
    expect(seenPrompt).toContain("make the headline blue");
    expect(seenPrompt).toContain("AcmeOld");
    expect(seenPrompt.toLowerCase()).toContain("revision");
    // Assets already living in the composition dir are listed as reusable.
    expect(seenPrompt).toContain("bg-texture.png");

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
  });

  it("falls back to from-scratch authoring with the refinement when no composition exists yet", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    let seenPrompt = "";
    faux.setResponses([
      (context) => {
        seenPrompt = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML }),
        );
      },
      fauxAssistantMessage(fauxText("done")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      refinement: "make the headline blue",
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(seenPrompt).toContain("make the headline blue");
    expect(seenPrompt).toContain("Author index.html now");
  });

  it("runs a multimodal creative-director revision and re-validates the result", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    let revisionPrompt = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
      fauxAssistantMessage(fauxText("authored")),
      (context) => {
        const users = (context.messages as any[]).filter((message) => message.role === "user");
        revisionPrompt = JSON.stringify(users.at(-1)?.content ?? "");
        return fauxAssistantMessage(
          fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML }),
        );
      },
      fauxAssistantMessage(fauxText("revised")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);
    let qualityChecks = 0;
    let reviews = 0;
    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: { check: async () => { qualityChecks++; return { ok: true, diagnostics: "" }; } },
      snapshotRunner: {
        capture: async () => [{ sceneId: "s1", moment: "hero", timeSec: 3, path: "/tmp/frame.png" }],
      },
      visualCritic: {
        critique: async () => {
          reviews++;
          return reviews === 1
            ? {
                ok: false, score: 68, summary: "The sequence reads like a landing page",
                issues: [{
                  sceneId: "s1", category: "webpage_like" as const, severity: "high" as const,
                  note: "Centered card stack has no cinematic depth", fix: "Use an edge-anchored split frame",
                }],
              }
            : { ok: true, score: 84, summary: "Commercially coherent", issues: [] };
        },
      },
      maxVisualRounds: 1,
    });
    const events: ServerEvent[] = [];
    for await (const event of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) events.push(event);

    expect(reviews).toBe(2); // initial review + final look after the revision
    expect(qualityChecks).toBe(2); // creative edits must re-pass objective validation
    expect(revisionPrompt).toContain("landing page");
    expect(revisionPrompt).toContain("edge-anchored split frame");
    expect(events.some((event) => event.type === "phase.progress" && /68\/100/.test((event as any).message))).toBe(true);
    const composition = await store.get("s1", "composition");
    expect((composition?.data as any).quality).toMatchObject({
      commercialScore: 84, passed: true, remainingIssues: [],
      reviewCount: 2, scoreHistory: [68, 84],
    });
    expect((composition?.data as any).quality.sampledFrames).toHaveLength(6);
    expect(events.some((event) =>
      event.type === "phase.progress" && /quality review passed \(84\/100\)/i.test((event as any).message),
    )).toBe(true);
  });

  it("repairs a composition that drops a director-planned SFX cue", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    const withSfx = VALID_HTML.replace(
      "</div>\n<script>",
      '<audio src="impact-bass-1.mp3" data-start="2" data-duration="2.12" data-track-index="3" data-volume="0.3"></audio>\n</div>\n<script>',
    );
    let repairPrompt = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
      fauxAssistantMessage(fauxText("authored")),
      (context) => {
        const users = (context.messages as any[]).filter((message) => message.role === "user");
        repairPrompt = JSON.stringify(users.at(-1)?.content ?? "");
        return fauxAssistantMessage(
          fauxToolCall("write_composition_file", { path: "index.html", content: withSfx }),
        );
      },
      fauxAssistantMessage(fauxText("repaired")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seed(store, wm);
    await store.put("s1", "script", {
      ...script,
      productionPlan: {
        rhythmPattern: "punch-build", primaryTransition: "push", accentTransitions: [],
        recurringMotifs: ["rule"], soundDirection: "sparse impact",
        energyCurve: [
          { sceneId: "s1", level: "high", purpose: "hook" },
          { sceneId: "s2", level: "peak", purpose: "payoff" },
        ],
        scenes: [
          {
            sceneId: "s1", concept: "claim", purpose: "hook", moodDirection: "urgent",
            shotType: "macro", cameraMove: "push", heroFrameAtSec: 3,
            depthLayers: { background: ["grain"], midground: ["claim"], foreground: ["rule"] },
            choreography: [{ target: "claim", verb: "slams", timing: "0.2s" }],
            transitionOut: { type: "push", durationSec: 0.3, ease: "power3.inOut", reason: "advance" },
            effectSlots: [],
            sfxCues: [{ type: "impact-bass-1", atSec: 2, purpose: "claim lock", volume: 0.3 }],
          },
          {
            sceneId: "s2", concept: "proof", purpose: "hero", moodDirection: "confident",
            shotType: "wide", cameraMove: "orbit", heroFrameAtSec: 3,
            depthLayers: { background: ["glow"], midground: ["product"], foreground: ["logo"] },
            choreography: [{ target: "product", verb: "locks", timing: "1s" }],
            effectSlots: [], sfxCues: [],
          },
        ],
      },
    });
    let checks = 0;
    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}), model: faux.getModel("uc-test")!,
      qualityRunner: { check: async () => { checks++; return { ok: true, diagnostics: "" }; } },
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }
    expect(checks).toBe(2);
    expect(repairPrompt).toContain("impact-bass-1");
    expect(repairPrompt).toContain("global t=2.00s");
    expect(readFileSync(join(wm.paths("s1").composition, "index.html"), "utf8"))
      .toContain("impact-bass-1.mp3");
  });

  it("throws when the upstream design artifact is missing", async () => {
    const faux = fauxAuthoring();
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await wm.init("s1");
    await store.put("s1", "brief", brief);
    await store.put("s1", "script", script);

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
        signal: new AbortController().signal,
      } as any)) { /* drain */ }
    }).rejects.toThrow(/design/i);
  });
});
