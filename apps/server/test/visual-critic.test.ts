import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { GeminiVisualCritic } from "../src/render/visual-critic.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("GeminiVisualCritic", () => {
  it("sends labelled images and fails a high-severity commercial-quality issue", async () => {
    const root = mkdtempSync(join(tmpdir(), "uc-critic-")); roots.push(root);
    const frame = join(root, "frame.png");
    await sharp({ create: { width: 80, height: 45, channels: 3, background: "red" } }).png().toFile(frame);
    let request: any;
    const critic = new GeminiVisualCritic({
      apiKey: "test",
      client: { models: { generateContent: async (input) => {
        request = input;
        return { text: JSON.stringify({
          score: 72, summary: "Feels like a landing page",
          issues: [{ sceneId: "s1", category: "webpage_like", severity: "high", note: "Centered cards", fix: "Use a cinematic split frame" }],
        }) };
      } } },
    });
    const verdict = await critic.critique({
      frames: [{ sceneId: "s1", moment: "hero", timeSec: 2, path: frame }],
      script: { totalSec: 4, scenes: [{ id: "s1", startSec: 0, durationSec: 4, visual: "hero" }] },
      design: { mood: "bold", palette: [], typography: { heading: "A", body: "B" }, motionStyle: "fast", keyVisuals: [], sampleFrames: [] },
      signal: new AbortController().signal,
    });
    expect(verdict.ok).toBe(false);
    expect(request.contents[0].parts.some((part: any) => part.inlineData)).toBe(true);
    expect(JSON.stringify(request)).toContain("scene=s1; moment=hero");
  });
});
