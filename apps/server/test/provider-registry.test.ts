import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { TTSProvider } from "../src/providers/types.js";

function makeTTS(id: string): TTSProvider {
  return {
    id,
    async synthesize() {
      return { audioPath: `${id}.mp3`, durationMs: 1000 };
    },
  };
}

describe("ProviderRegistry", () => {
  it("registers and retrieves a provider by type and id", () => {
    const r = new ProviderRegistry();
    const p = makeTTS("gemini");
    r.register("tts", p);
    expect(r.get("tts", "gemini")).toBe(p);
  });

  it("get without an id returns the first-registered provider of that type", () => {
    const r = new ProviderRegistry();
    const a = makeTTS("a");
    const b = makeTTS("b");
    r.register("tts", a);
    r.register("tts", b);
    expect(r.get("tts")).toBe(a);
  });

  it("returns undefined for an unregistered type or id", () => {
    const r = new ProviderRegistry();
    expect(r.get("tts")).toBeUndefined();
    expect(r.get("tts", "nope")).toBeUndefined();
  });

  it("rejects duplicate registrations under the same (type, id)", () => {
    const r = new ProviderRegistry();
    r.register("tts", makeTTS("gemini"));
    expect(() => r.register("tts", makeTTS("gemini"))).toThrow(/duplicate/i);
  });

  it("require throws a useful error if the provider is missing", () => {
    const r = new ProviderRegistry();
    expect(() => r.require("tts")).toThrow(/no provider/i);
    expect(() => r.require("tts", "gemini")).toThrow(/no provider/i);
  });
});
