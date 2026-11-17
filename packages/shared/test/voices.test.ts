import { describe, it, expect } from "vitest";
import {
  VOICES,
  ALLOWED_VOICES,
  VoiceSchema,
  DEFAULT_VOICE,
} from "../src/voices.js";

describe("voice catalog", () => {
  it("lists 30 voices, each with a name and exactly two non-empty tags", () => {
    expect(VOICES).toHaveLength(30);
    for (const v of VOICES) {
      expect(typeof v.name).toBe("string");
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.tags).toHaveLength(2);
      expect(v.tags[0].length).toBeGreaterThan(0);
      expect(v.tags[1].length).toBeGreaterThan(0);
    }
  });

  it("ALLOWED_VOICES matches the catalog names with no duplicates", () => {
    expect(ALLOWED_VOICES).toEqual(VOICES.map((v) => v.name));
    expect(new Set(ALLOWED_VOICES).size).toBe(ALLOWED_VOICES.length);
  });

  it("DEFAULT_VOICE is Kore and is a known voice", () => {
    expect(DEFAULT_VOICE).toBe("Kore");
    expect(ALLOWED_VOICES).toContain(DEFAULT_VOICE);
  });

  it("VoiceSchema accepts a known voice and rejects an unknown one", () => {
    expect(VoiceSchema.parse("Puck")).toBe("Puck");
    expect(() => VoiceSchema.parse("Nope")).toThrow();
  });
});
