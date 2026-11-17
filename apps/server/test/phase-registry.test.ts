import { describe, it, expect } from "vitest";
import type { Brief } from "@ultracreator/shared";
import { PhaseRegistry } from "../src/phases/registry.js";

const baseBrief: Brief = {
  product: { name: "x", tagline: "y", description: "z", category: "c" },
  audience: "a",
  keyMessages: ["m"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

describe("PhaseRegistry", () => {
  const r = new PhaseRegistry();

  it("getPhase returns each phase config in spec order", () => {
    expect(r.getPhase("research").id).toBe("research");
    // Research gates so the user can curate captured assets before design
    // derives keyVisuals from them.
    expect(r.getPhase("research").gates).toEqual(["user-approve"]);
    expect(r.getPhase("design").gates).toEqual(["user-approve"]);
    expect(r.getPhase("script").gates).toEqual(["user-approve"]);
    expect(r.getPhase("voiceover").gates).toEqual(["user-approve"]);
    expect(r.getPhase("compose").gates ?? []).toEqual([]);
    expect(r.getPhase("render").gates ?? []).toEqual([]);
  });

  it("research advances to design (after its gate)", () => {
    expect(r.next("research", baseBrief)!.id).toBe("design");
  });

  it("design → script → voiceover when withVoiceover=true", () => {
    const b = { ...baseBrief, constraints: { ...baseBrief.constraints, withVoiceover: true } };
    expect(r.next("design", b)!.id).toBe("script");
    expect(r.next("script", b)!.id).toBe("voiceover");
    expect(r.next("voiceover", b)!.id).toBe("compose");
  });

  it("skips voiceover when withVoiceover=false", () => {
    expect(r.next("script", baseBrief)!.id).toBe("compose");
  });

  it("render is terminal", () => {
    expect(r.next("render", baseBrief)).toBeNull();
  });

  it("previous walks the canonical chain regardless of enabled()", () => {
    expect(r.previous("design")!.id).toBe("research");
    expect(r.previous("script")!.id).toBe("design");
    expect(r.previous("voiceover")!.id).toBe("script");
    expect(r.previous("compose")!.id).toBe("voiceover");
    expect(r.previous("render")!.id).toBe("compose");
    expect(r.previous("research")).toBeNull();
  });

  it("outputs returns the artifact kinds each phase writes", () => {
    expect(r.outputs("research")).toEqual(["brief"]);
    expect(r.outputs("design")).toEqual(["design"]);
    expect(r.outputs("script")).toEqual(["script"]);
    expect(r.outputs("voiceover")).toEqual(["narration"]);
    expect(r.outputs("compose")).toEqual(["composition", "music"]);
    expect(r.outputs("render")).toEqual(["mp4", "subtitles"]);
  });

  it("downstream returns every phase strictly after the given phase, in order", () => {
    expect(r.downstream("research")).toEqual(["design", "script", "voiceover", "compose", "render"]);
    expect(r.downstream("design")).toEqual(["script", "voiceover", "compose", "render"]);
    expect(r.downstream("script")).toEqual(["voiceover", "compose", "render"]);
    expect(r.downstream("voiceover")).toEqual(["compose", "render"]);
    expect(r.downstream("compose")).toEqual(["render"]);
    expect(r.downstream("render")).toEqual([]);
  });
});
