import { describe, it, expect } from "vitest";
import { buildResearchPrompt } from "../src/phases/pi-research-handler.js";

describe("buildResearchPrompt", () => {
  it("lists labeled assets and marks the logo", () => {
    const prompt = buildResearchPrompt(
      {
        text: "Use @logo and @image1 for the promo",
        assets: [
          { label: "logo", path: "assets/logo.png", role: "logo" },
          { label: "image1", path: "assets/a.png", role: "image" },
        ],
      },
      undefined,
    );
    expect(prompt).toContain("Referenced assets");
    expect(prompt).toContain("- @logo → assets/logo.png (the brand LOGO)");
    expect(prompt).toContain("- @image1 → assets/a.png");
    expect(prompt).toContain("Use @logo and @image1");
  });

  it("falls back to the flat uploaded-files line when no assets", () => {
    const prompt = buildResearchPrompt(
      { text: "hello", uploadedFiles: ["uploads/x.png"] },
      undefined,
    );
    expect(prompt).toContain("Uploaded files: uploads/x.png");
    expect(prompt).not.toContain("Referenced assets");
  });

  it("serializes constraints and appends refinement", () => {
    const prompt = buildResearchPrompt(
      {
        text: "Make a promo",
        constraints: { durationSec: 120, aspectRatio: "16:9", withVoiceover: false },
      },
      "make it punchier",
    );
    expect(prompt).toContain('Constraints: {"durationSec":120,"aspectRatio":"16:9","withVoiceover":false}');
    expect(prompt).toContain("Refinement: make it punchier");
    // The parts are joined by a blank line.
    expect(prompt).toMatch(/Make a promo\n\nConstraints:/);
  });

  it("returns a default when there is nothing to say", () => {
    expect(buildResearchPrompt(undefined, undefined)).toBe("Begin research.");
  });
});
