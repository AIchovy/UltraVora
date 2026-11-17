import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Script } from "@ultracreator/shared";
import {
  findProductionPlanComplianceViolations,
  parseCompositionClips,
} from "../src/render/production-plan-compliance-check.js";

let root: string;
let sfxDir: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-plan-check-"));
  sfxDir = join(root, "sfx");
  await mkdir(sfxDir);
  await writeFile(join(sfxDir, "manifest.json"), JSON.stringify({
    impact: { file: "impact.mp3" }, whoosh: { file: "whoosh.mp3" },
  }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const script: Script = {
  totalSec: 10,
  scenes: [
    { id: "hook", startSec: 0, durationSec: 3, visual: "claim" },
    { id: "hero", startSec: 3, durationSec: 7, visual: "reveal" },
  ],
  productionPlan: {
    rhythmPattern: "punch-build-peak", primaryTransition: "push", accentTransitions: [],
    recurringMotifs: ["rule"], soundDirection: "sparse impacts",
    energyCurve: [
      { sceneId: "hook", level: "high", purpose: "hook" },
      { sceneId: "hero", level: "peak", purpose: "payoff" },
    ],
    scenes: [
      {
        sceneId: "hook", concept: "claim", purpose: "hook", moodDirection: "urgent",
        shotType: "macro", cameraMove: "push", heroFrameAtSec: 1.5,
        depthLayers: { background: ["grain"], midground: ["claim"], foreground: ["rule"] },
        choreography: [{ target: "claim", verb: "slams", timing: "0.2s" }],
        transitionOut: { type: "push", durationSec: 0.3, ease: "power3.inOut", reason: "advance" },
        effectSlots: [],
        sfxCues: [{ type: "impact", atSec: 1.5, purpose: "claim lock", volume: 0.3 }],
      },
      {
        sceneId: "hero", concept: "reveal", purpose: "hero", moodDirection: "confident",
        shotType: "wide", cameraMove: "orbit", heroFrameAtSec: 4,
        depthLayers: { background: ["glow"], midground: ["product"], foreground: ["logo"] },
        choreography: [{ target: "product", verb: "locks", timing: "1s" }],
        effectSlots: [], sfxCues: [],
      },
    ],
  },
};

const validHtml = `<!doctype html><body>
<div id="root" data-height="1080" data-composition-id="main" data-duration="10" data-start="0">
  <div data-duration='3' id='hook' data-track-index='1' data-start='0'></div>
  <div id="hero" data-start="3" data-duration="7" data-track-index="1"></div>
  <audio data-volume="0.3" src="impact.mp3" data-duration="2" data-start="1.5" data-track-index="3"></audio>
</div></body>`;

describe("production-plan composition compliance", () => {
  it("parses single/double-quoted attributes independently of order", () => {
    const clips = parseCompositionClips(validHtml);
    expect(clips.find((clip) => clip.id === "hook")).toMatchObject({ startSec: 0, durationSec: 3 });
    expect(clips.find((clip) => clip.tag === "audio")).toMatchObject({ src: "impact.mp3", volume: 0.3 });
  });

  it("passes when scene windows and planned production SFX are implemented", async () => {
    await writeFile(join(root, "index.html"), validHtml);
    expect(await findProductionPlanComplianceViolations(root, script, sfxDir)).toEqual([]);
  });

  it("flags dropped scene timing, missing cues and unplanned SFX", async () => {
    await writeFile(join(root, "index.html"), validHtml
      .replace('data-start="3"', 'data-start="4"')
      .replace("data-start=\"1.5\"", "data-start=\"2.0\"")
      .replace("</div></body>", '<audio src="whoosh.mp3" data-start="8" data-duration="1" data-track-index="4"></audio></div></body>'));
    const violations = await findProductionPlanComplianceViolations(root, script, sfxDir);
    expect(violations.join("\n")).toContain("Scene #hero");
    expect(violations.join("\n")).toContain("missing at global t=1.50s");
    expect(violations.join("\n")).toContain("not a director-planned cue");
  });

  it("flags a planned effect whose mix level drifts from the director plan", async () => {
    await writeFile(join(root, "index.html"), validHtml.replace('data-volume="0.3"', 'data-volume="0.8"'));
    const violations = await findProductionPlanComplianceViolations(root, script, sfxDir);
    expect(violations.join("\n")).toContain("must use volume 0.3");
  });
});
