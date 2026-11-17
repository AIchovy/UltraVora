import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BriefSchema } from "@ultracreator/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import {
  makeWriteBriefTool,
  makeWriteDesignTool,
  makeWriteScriptTool,
} from "../src/tools/artifact-write-tools.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-tools-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function makeStore() {
  const wm = new WorkspaceManager(root);
  const bus = new EventBus();
  const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
  await wm.init("s1");
  return { wm, bus, store };
}

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

describe("write_brief tool", () => {
  it("writes a valid brief and returns the new version number", async () => {
    const { store } = await makeStore();
    const tool = makeWriteBriefTool({ sessionId: "s1", artifacts: store });
    const result = await tool.execute("call-1", briefData);
    expect(result.details).toMatchObject({ kind: "brief", version: 1 });
    expect(result.content[0]).toMatchObject({ type: "text" });
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")!.version).toBe(1);
  });

  it("throws if the brief data is invalid (defense against off-schema LLM output)", async () => {
    const { store } = await makeStore();
    const tool = makeWriteBriefTool({ sessionId: "s1", artifacts: store });
    await expect(tool.execute("call-1", { product: { name: "x" } } as never)).rejects.toThrow();
  });

  it("includes derivedFrom in the resulting descriptor when supplied", async () => {
    const { store } = await makeStore();
    await store.put("s1", "brief", briefData); // v1
    const tool = makeWriteBriefTool({
      sessionId: "s1",
      artifacts: store,
      derivedFrom: [{ kind: "brief", version: 1 }],
    });
    await tool.execute("call-1", briefData);
    const list = await store.list("s1");
    const v2 = list.find((d) => d.kind === "brief" && d.version === 2)!;
    expect(v2.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
  });

  // The TypeBox `parameters` schema is what the LLM sees. If it omits the
  // optional subtitles/bgm constraints, the model never emits them, so the
  // user's UI toggles get silently dropped before the brief is written —
  // and the compose phase then skips captions and BGM entirely.
  it("advertises optional subtitles/bgm in the constraints parameter schema", async () => {
    const { store } = await makeStore();
    const tool = makeWriteBriefTool({ sessionId: "s1", artifacts: store });
    const constraintProps = (tool.parameters as any).properties.constraints
      .properties;
    expect(constraintProps.subtitles).toMatchObject({ type: "boolean" });
    expect(constraintProps.bgm).toMatchObject({ type: "boolean" });
  });

  it("persists subtitles/bgm when the agent supplies them", async () => {
    const { store } = await makeStore();
    const tool = makeWriteBriefTool({ sessionId: "s1", artifacts: store });
    await tool.execute("call-1", {
      ...briefData,
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true, subtitles: true, bgm: true },
    } as never);
    const env = await store.get("s1", "brief");
    expect((env!.data as any).constraints).toMatchObject({ subtitles: true, bgm: true });
  });

  // Voice is a pure user-UI choice with no other origin. Rather than trust the
  // LLM to copy it into write_brief (the TypeBox schema doesn't even expose
  // `voice`), the handler passes the user's constraints in and the tool stamps
  // them onto the brief deterministically. Regression: picking "Achird" still
  // rendered with the default voice (Kore) because the brief never carried it.
  it("stamps the user's chosen voice onto the brief even when the agent omits it", async () => {
    const { store } = await makeStore();
    const tool = makeWriteBriefTool({
      sessionId: "s1",
      artifacts: store,
      userConstraints: {
        durationSec: 30,
        aspectRatio: "16:9",
        withVoiceover: true,
        voice: "Achird",
      },
    });
    // The agent's write_brief params carry no voice (the schema hides it).
    await tool.execute("call-1", {
      ...briefData,
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
    } as never);
    const env = await store.get("s1", "brief");
    expect((env!.data as any).constraints.voice).toBe("Achird");
  });

  // The user's explicit UI toggles are authoritative: if the model drifts and
  // emits a different value, the user's choice must still win. This is the
  // general form of the voice bug — no user-set constraint should be at the
  // mercy of LLM transcription.
  it("lets the user's constraints win over conflicting values from the agent", async () => {
    const { store } = await makeStore();
    const tool = makeWriteBriefTool({
      sessionId: "s1",
      artifacts: store,
      userConstraints: {
        durationSec: 30,
        aspectRatio: "16:9",
        withVoiceover: true,
        subtitles: true,
        voice: "Puck",
      },
    });
    await tool.execute("call-1", {
      ...briefData,
      // Agent disagrees: subtitles off, and a stray voice it should not control.
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true, subtitles: false },
    } as never);
    const env = await store.get("s1", "brief");
    expect((env!.data as any).constraints).toMatchObject({ subtitles: true, voice: "Puck" });
  });
});

describe("write_design tool", () => {
  it("writes a valid design", async () => {
    const { store } = await makeStore();
    await store.put("s1", "brief", briefData);
    const tool = makeWriteDesignTool({ sessionId: "s1", artifacts: store });
    const result = await tool.execute("call-1", {
      mood: "energetic",
      palette: [{ name: "p", hex: "#000" }],
      colorRoles: { background: "#000000", foreground: "#ffffff", accent: "#ff3366" },
      typography: { heading: "A", body: "B" },
      motionStyle: "fades",
      keyVisuals: [],
      sampleFrames: [],
    });
    expect(result.details).toMatchObject({ kind: "design", version: 1 });
  });
});

describe("write_script tool", () => {
  it("writes a valid script", async () => {
    const { store } = await makeStore();
    await store.put("s1", "brief", briefData);
    const tool = makeWriteScriptTool({ sessionId: "s1", artifacts: store });
    const result = await tool.execute("call-1", {
      totalSec: 30,
      scenes: [{ id: "s1", startSec: 0, durationSec: 5, visual: "shot" }],
    });
    expect(result.details).toMatchObject({ kind: "script", version: 1 });
  });

  // TTS speaks ~2.4 words/sec. A scene whose narration is far longer than its
  // window gets silently re-timed by the voiceover phase, wrecking the pacing
  // the script planned — so reject the mismatch here where the agent can fix it.
  describe("narration word budget", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

    it("rejects a scene whose narration blows its duration budget", async () => {
      const { store } = await makeStore();
      const tool = makeWriteScriptTool({ sessionId: "s1", artifacts: store });
      // 5s scene → budget 12 words; 30 words ≈ 12.5s of speech (>35% off).
      await expect(
        tool.execute("call-1", {
          totalSec: 30,
          scenes: [
            { id: "s1", startSec: 0, durationSec: 5, visual: "v", narration: words(30) },
            { id: "s2", startSec: 5, durationSec: 25, visual: "v", narration: words(60) },
          ],
        }),
      ).rejects.toThrow(/s1/);
    });

    it("accepts shorter narration as intentional breathing room", async () => {
      const { store } = await makeStore();
      const tool = makeWriteScriptTool({ sessionId: "s1", artifacts: store });
      const result = await tool.execute("call-1", {
        totalSec: 30,
        scenes: [
          { id: "hook", startSec: 0, durationSec: 10, visual: "v", narration: words(4) },
          { id: "s2", startSec: 10, durationSec: 20, visual: "v", narration: words(30) },
        ],
      });
      expect(result.details).toMatchObject({ kind: "script", version: 1 });
    });

    it("accepts narration within tolerance and silent scenes", async () => {
      const { store } = await makeStore();
      const tool = makeWriteScriptTool({ sessionId: "s1", artifacts: store });
      const result = await tool.execute("call-1", {
        totalSec: 30,
        scenes: [
          // 10s → budget 24 words; 20 words is within ±35%.
          { id: "s1", startSec: 0, durationSec: 10, visual: "v", narration: words(20) },
          { id: "s2", startSec: 10, durationSec: 20, visual: "v" }, // silent — skipped
        ],
      });
      expect(result.details).toMatchObject({ kind: "script", version: 1 });
    });

    it("skips the check entirely for narration-free scripts", async () => {
      const { store } = await makeStore();
      const tool = makeWriteScriptTool({ sessionId: "s1", artifacts: store });
      const result = await tool.execute("call-1", {
        totalSec: 30,
        scenes: [{ id: "s1", startSec: 0, durationSec: 30, visual: "v" }],
      });
      expect(result.details).toMatchObject({ kind: "script", version: 1 });
    });
  });

  it("rejects a script whose totalSec deviates from the expected duration", async () => {
    const { store } = await makeStore();
    const tool = makeWriteScriptTool({
      sessionId: "s1",
      artifacts: store,
      expectedDurationSec: 30,
    });
    await expect(
      tool.execute("call-1", {
        totalSec: 45,
        scenes: [{ id: "s1", startSec: 0, durationSec: 45, visual: "v" }],
      }),
    ).rejects.toThrow(/30/);
  });

  it("persists a production plan whose directions map one-to-one to scenes", async () => {
    const { store } = await makeStore();
    const tool = makeWriteScriptTool({ sessionId: "s1", artifacts: store });
    await tool.execute("call-1", {
      totalSec: 5,
      scenes: [{ id: "hero", startSec: 0, durationSec: 5, visual: "product reveal" }],
      productionPlan: {
        rhythmPattern: "build-PEAK",
        energyCurve: [{ sceneId: "hero", level: "peak", purpose: "reveal" }],
        primaryTransition: "zoom through",
        accentTransitions: [],
        recurringMotifs: ["orbiting line"],
        soundDirection: "single impact",
        scenes: [{
          sceneId: "hero", concept: "Product enters a cinematic stage", purpose: "hero",
          moodDirection: "precision product film", shotType: "macro", cameraMove: "orbit",
          heroFrameAtSec: 3,
          depthLayers: { background: ["glow"], midground: ["product"], foreground: ["rule"] },
          choreography: [{ target: "product", verb: "LOCKS IN", timing: "0.4-2s" }],
          effectSlots: ["shimmer sweep"],
          sfxCues: [{ type: "impact-bass-1", atSec: 2, purpose: "hero lock", volume: 0.3 }],
        }],
      },
    });
    const saved = await store.get("s1", "script");
    expect((saved?.data as any).productionPlan.rhythmPattern).toBe("build-PEAK");
  });

  it("normalizes numeric energy scores and permits a zero-duration hard cut", async () => {
    const { store } = await makeStore();
    const tool = makeWriteScriptTool({ sessionId: "s1", artifacts: store });
    await tool.execute("call-1", {
      totalSec: 8,
      scenes: [
        { id: "hook", startSec: 0, durationSec: 4, visual: "claim" },
        { id: "cta", startSec: 4, durationSec: 4, visual: "cta" },
      ],
      productionPlan: {
        rhythmPattern: "punch-hold",
        energyCurve: [
          { sceneId: "hook", level: 5, purpose: "hook" },
          { sceneId: "cta", level: 1, purpose: "close" },
        ],
        primaryTransition: "hard cut",
        accentTransitions: [],
        recurringMotifs: ["rule"],
        soundDirection: "dry",
        scenes: [
          {
            sceneId: "hook", concept: "claim", purpose: "hook", moodDirection: "urgent",
            shotType: "macro", cameraMove: "push", heroFrameAtSec: 1,
            depthLayers: { background: ["grain"], midground: ["claim"], foreground: ["rule"] },
            choreography: [{ target: "claim", verb: "SLAMS", timing: "0.2s" }],
            transitionOut: { type: "hard cut", durationSec: 0, ease: "none", reason: "clean punctuation" },
            effectSlots: [], sfxCues: [],
          },
          {
            sceneId: "cta", concept: "close", purpose: "cta", moodDirection: "calm",
            shotType: "wide", cameraMove: "still", heroFrameAtSec: 2,
            depthLayers: { background: ["field"], midground: ["logo"], foreground: ["cta"] },
            choreography: [{ target: "logo", verb: "SETTLES", timing: "1s" }],
            effectSlots: [], sfxCues: [],
          },
        ],
      },
    });

    const saved = await store.get("s1", "script");
    expect((saved?.data as any).productionPlan.energyCurve.map((p: any) => p.level)).toEqual(["peak", "low"]);
    expect((saved?.data as any).productionPlan.scenes[0].transitionOut.durationSec).toBe(0);
  });

  it("rejects zero duration for an animated transition", async () => {
    const { store } = await makeStore();
    const tool = makeWriteScriptTool({ sessionId: "s1", artifacts: store });
    await expect(tool.execute("call-1", {
      totalSec: 8,
      scenes: [
        { id: "hook", startSec: 0, durationSec: 4, visual: "claim" },
        { id: "cta", startSec: 4, durationSec: 4, visual: "cta" },
      ],
      productionPlan: {
        rhythmPattern: "build-hold",
        energyCurve: [
          { sceneId: "hook", level: "high", purpose: "hook" },
          { sceneId: "cta", level: "low", purpose: "close" },
        ],
        primaryTransition: "dissolve",
        accentTransitions: [],
        recurringMotifs: ["rule"],
        soundDirection: "dry",
        scenes: [
          {
            sceneId: "hook", concept: "claim", purpose: "hook", moodDirection: "urgent",
            shotType: "macro", cameraMove: "push", heroFrameAtSec: 1,
            depthLayers: { background: ["grain"], midground: ["claim"], foreground: ["rule"] },
            choreography: [{ target: "claim", verb: "SLAMS", timing: "0.2s" }],
            transitionOut: { type: "dissolve", durationSec: 0, ease: "none", reason: "shift" },
            effectSlots: [], sfxCues: [],
          },
          {
            sceneId: "cta", concept: "close", purpose: "cta", moodDirection: "calm",
            shotType: "wide", cameraMove: "still", heroFrameAtSec: 2,
            depthLayers: { background: ["field"], midground: ["logo"], foreground: ["cta"] },
            choreography: [{ target: "logo", verb: "SETTLES", timing: "1s" }],
            effectSlots: [], sfxCues: [],
          },
        ],
      },
    })).rejects.toThrow(/durationSec may be 0 only for a hard cut/);
  });

  it("rejects production directions for unknown scenes", async () => {
    const { store } = await makeStore();
    const tool = makeWriteScriptTool({ sessionId: "s1", artifacts: store });
    await expect(tool.execute("call-1", {
      totalSec: 5,
      scenes: [{ id: "hero", startSec: 0, durationSec: 5, visual: "product reveal" }],
      productionPlan: {
        rhythmPattern: "build", energyCurve: [{ sceneId: "hero", level: "high", purpose: "build" }],
        primaryTransition: "cut", accentTransitions: [], recurringMotifs: ["line"], soundDirection: "dry",
        scenes: [{
          sceneId: "wrong", concept: "x", purpose: "x", moodDirection: "x", shotType: "x",
          cameraMove: "x", heroFrameAtSec: 1,
          depthLayers: { background: ["x"], midground: ["x"], foreground: ["x"] },
          choreography: [{ target: "x", verb: "SLIDES", timing: "0-1s" }],
          effectSlots: [], sfxCues: [],
        }],
      },
    } as never)).rejects.toThrow(/missing: hero.*unknown: wrong/);
  });

  it("rejects gaps and incomplete transition edits in a production plan", async () => {
    const { store } = await makeStore();
    const tool = makeWriteScriptTool({ sessionId: "s1", artifacts: store });
    const base = {
      totalSec: 8,
      scenes: [
        { id: "hook", startSec: 0, durationSec: 3, visual: "claim" },
        { id: "cta", startSec: 4, durationSec: 4, visual: "cta" },
      ],
      productionPlan: {
        rhythmPattern: "punch-hold", primaryTransition: "push", accentTransitions: [],
        recurringMotifs: ["rule"], soundDirection: "dry",
        energyCurve: [
          { sceneId: "hook", level: "high" as const, purpose: "hook" },
          { sceneId: "cta", level: "low" as const, purpose: "close" },
        ],
        scenes: [
          {
            sceneId: "hook", concept: "claim", purpose: "hook", moodDirection: "urgent",
            shotType: "macro", cameraMove: "push", heroFrameAtSec: 1,
            depthLayers: { background: ["grain"], midground: ["claim"], foreground: ["rule"] },
            choreography: [{ target: "claim", verb: "slams", timing: "0.2s" }],
            effectSlots: [], sfxCues: [],
          },
          {
            sceneId: "cta", concept: "close", purpose: "cta", moodDirection: "calm",
            shotType: "wide", cameraMove: "still", heroFrameAtSec: 2,
            depthLayers: { background: ["field"], midground: ["logo"], foreground: ["cta"] },
            choreography: [{ target: "logo", verb: "settles", timing: "1s" }],
            effectSlots: [], sfxCues: [],
          },
        ],
      },
    };
    await expect(tool.execute("call-gap", base)).rejects.toThrow(/continuous edit/);
    await expect(tool.execute("call-transition", {
      ...base,
      scenes: [
        { id: "hook", startSec: 0, durationSec: 4, visual: "claim" },
        { id: "cta", startSec: 4, durationSec: 4, visual: "cta" },
      ],
    })).rejects.toThrow(/transitionOut/);
  });
});

describe("BriefSchema brandHints.logoFile", () => {
  it("accepts an optional local logoFile path", () => {
    const parsed = BriefSchema.parse({
      product: { name: "A", tagline: "t", description: "d", category: "saas" },
      audience: "devs",
      keyMessages: ["m"],
      brandHints: { colors: ["#000"], logoFile: "assets/abc.png" },
      sourceAssets: { images: ["assets/x.png"], videos: [], copy: [] },
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(parsed.brandHints.logoFile).toBe("assets/abc.png");
  });

  it("still parses without logoFile", () => {
    const parsed = BriefSchema.parse({
      product: { name: "A", tagline: "t", description: "d", category: "saas" },
      audience: "devs",
      keyMessages: ["m"],
      brandHints: { colors: ["#000"] },
      sourceAssets: { images: [], videos: [], copy: [] },
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(parsed.brandHints.logoFile).toBeUndefined();
  });
});
