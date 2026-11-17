import { describe, it, expect } from "vitest";
import { PHASE_IDS } from "@ultracreator/shared";

describe("phase ordering with compose", () => {
  it("orders compose between voiceover and render", () => {
    expect([...PHASE_IDS]).toEqual([
      "research", "design", "script", "voiceover", "compose", "render",
    ]);
  });
});
