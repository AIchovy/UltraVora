import { describe, expect, it } from "vitest";
import { planCriticSamples } from "../src/render/snapshot-runner.js";

describe("visual critic sample plan", () => {
  it("captures build, hero and resolve moments inside each scene", () => {
    const samples = planCriticSamples([
      { id: "a", startSec: 0, durationSec: 4, visual: "a" },
      { id: "b", startSec: 4, durationSec: 6, visual: "b" },
    ]);
    expect(samples.filter((sample) => sample.sceneId === "a").map((sample) => sample.moment))
      .toEqual(["build", "hero", "resolve"]);
    expect(samples.every((sample) => sample.timeSec >= 0 && sample.timeSec < 10)).toBe(true);
  });

  it("keeps hero coverage when capped", () => {
    const scenes = Array.from({ length: 5 }, (_, index) => ({
      id: `s${index}`, startSec: index * 4, durationSec: 4, visual: "shot",
    }));
    const samples = planCriticSamples(scenes, 7);
    expect(samples).toHaveLength(7);
    expect(samples.filter((sample) => sample.moment === "hero")).toHaveLength(5);
  });

  it("reviews the director-planned hero frame instead of a generic midpoint", () => {
    const scenes = [{ id: "hero", startSec: 4, durationSec: 6, visual: "reveal" }];
    const samples = planCriticSamples(scenes, {
      productionPlan: {
        rhythmPattern: "build-peak", primaryTransition: "push", accentTransitions: [],
        recurringMotifs: ["rule"], soundDirection: "impact",
        energyCurve: [{ sceneId: "hero", level: "peak", purpose: "reveal" }],
        scenes: [{
          sceneId: "hero", concept: "reveal", purpose: "hero", moodDirection: "confident",
          shotType: "wide", cameraMove: "orbit", heroFrameAtSec: 4.25,
          depthLayers: { background: ["glow"], midground: ["product"], foreground: ["rule"] },
          choreography: [{ target: "product", verb: "locks", timing: "2s" }],
          effectSlots: [], sfxCues: [],
        }],
      },
    });
    expect(samples.find((sample) => sample.moment === "hero")?.timeSec).toBe(8.25);
  });
});
