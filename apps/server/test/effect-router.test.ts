import { describe, expect, it } from "vitest";
import type { Design, Script } from "@ultracreator/shared";
import {
  formatEffectRecommendationsForPrompt, recommendRegistryEffects,
} from "../src/registry/effect-router.js";
import type { RegistryCatalogEntry } from "../src/registry/registry-loader.js";

const design: Design = {
  mood: "premium tech",
  palette: [{ name: "ink", hex: "#050505" }],
  typography: { heading: "Geist", body: "Geist Mono" },
  motionStyle: "cinematic product camera",
  keyVisuals: [],
  sampleFrames: [],
};

const script: Script = {
  totalSec: 8,
  scenes: [{ id: "hero", startSec: 0, durationSec: 8, visual: "3D iPhone hero reveal" }],
  productionPlan: {
    rhythmPattern: "slow-build-PEAK",
    energyCurve: [{ sceneId: "hero", level: "peak", purpose: "product reveal" }],
    primaryTransition: "cinematic zoom",
    accentTransitions: [],
    recurringMotifs: ["liquid glass lens"],
    soundDirection: "one bass impact",
    scenes: [{
      sceneId: "hero", concept: "A real device emerges through liquid glass", purpose: "hero",
      moodDirection: "premium product film", shotType: "macro product shot",
      cameraMove: "slow orbit", heroFrameAtSec: 5,
      depthLayers: { background: ["aurora"], midground: ["iphone"], foreground: ["glass lens"] },
      choreography: [{ target: "iphone", verb: "ORBITS", timing: "0.5-5s" }],
      effectSlots: ["real 3D device", "liquid glass"], sfxCues: [],
    }],
  },
};

const entries: RegistryCatalogEntry[] = [
  { name: "vfx-iphone-device", type: "block", title: "iPhone Device", description: "Real 3D device", tags: ["3d", "device", "iphone"], dimensions: { width: 1920, height: 1080 } },
  { name: "caption-highlight", type: "component", title: "Highlight", description: "Text highlight", tags: ["text"] },
  { name: "stock-demo", type: "block", title: "Demo", description: "iPhone showcase", tags: ["iphone", "showcase"], dimensions: { width: 1920, height: 1080 } },
];

describe("effect router", () => {
  it("excludes emoji components even when social/caption intent matches", () => {
    const result = recommendRegistryEffects([
      ...entries,
      { name: "caption-emoji-pop", type: "component", title: "Emoji pop", description: "social captions", tags: ["social", "emoji"] },
      { name: "social-stickers", type: "component", title: "Stickers", description: "social captions", tags: ["Emoji"] },
    ], { ...script, scenes: [{ id: "hero", startSec: 0, durationSec: 8, visual: "social emoji captions" }] }, design);
    expect(result.some(({ entry }) => entry.name === "caption-emoji-pop" || entry.name === "social-stickers")).toBe(false);
    expect(result.some(({ entry }) => entry.name === "caption-highlight")).toBe(true);
  });

  it("shortlists semantic matches and excludes showcase demos", () => {
    const result = recommendRegistryEffects(entries, script, design, { width: 1920, height: 1080 });
    expect(result[0]?.entry.name).toBe("vfx-iphone-device");
    expect(result.some((item) => item.entry.name === "stock-demo")).toBe(false);
  });

  it("removes orientation-mismatched blocks but keeps reusable components", () => {
    const result = recommendRegistryEffects(entries, script, design, { width: 1080, height: 1920 });
    expect(result.some((item) => item.entry.type === "block")).toBe(false);
    expect(result.some((item) => item.entry.name === "caption-highlight")).toBe(true);
  });

  it("formats requested effect slots and warns against stock demo copy", () => {
    const text = formatEffectRecommendationsForPrompt(
      recommendRegistryEffects(entries, script, design), script,
    );
    expect(text).toContain("real 3D device");
    expect(text).toContain("vfx-iphone-device");
    expect(text).toMatch(/never ship stock demo/i);
  });

  it("routes Chinese creative intent to English registry metadata", () => {
    const chineseScript: Script = {
      ...script,
      scenes: [{ id: "hero", startSec: 0, durationSec: 8, visual: "真实手机设备从液态玻璃中出现" }],
      productionPlan: undefined,
    };
    const result = recommendRegistryEffects(entries, chineseScript, design, { width: 1920, height: 1080 });
    expect(result[0]?.entry.name).toBe("vfx-iphone-device");
  });
});
