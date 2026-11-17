import { describe, it, expect } from "vitest";
import { ConstraintsSchema, ALLOWED_DURATIONS, ALLOWED_ASPECT_RATIOS } from "../src/constraints.js";
import { BriefSchema } from "../src/brief.js";
import { DesignSchema } from "../src/design.js";
import { ScriptSchema } from "../src/script.js";
import {
  ARTIFACT_KINDS,
  ARTIFACT_DATA_SCHEMAS,
  ArtifactDescriptorSchema,
} from "../src/artifact.js";
import { ServerEventSchema } from "../src/events.js";
import { INTENTS, IntentSchema } from "../src/intent.js";
import { UserMessageSchema, AssetRefSchema } from "../src/message.js";
import * as shared from "../src/index.js";

describe("ConstraintsSchema", () => {
  it("accepts a valid constraints object", () => {
    const value = { durationSec: 30, aspectRatio: "16:9", withVoiceover: true };
    expect(ConstraintsSchema.parse(value)).toEqual(value);
  });

  it("rejects a duration not in the allowed set", () => {
    const value = { durationSec: 25, aspectRatio: "16:9", withVoiceover: false };
    expect(() => ConstraintsSchema.parse(value)).toThrow();
  });

  it("accepts an optional subtitles flag and retains it", () => {
    const value = { durationSec: 30, aspectRatio: "16:9", withVoiceover: true, subtitles: true };
    expect(ConstraintsSchema.parse(value)).toEqual(value);
  });

  it("treats subtitles as optional (parses when omitted)", () => {
    const value = { durationSec: 30, aspectRatio: "16:9", withVoiceover: false };
    const parsed = ConstraintsSchema.parse(value);
    expect(parsed.subtitles).toBeUndefined();
  });

  it("accepts an optional bgm flag and retains it", () => {
    const value = { durationSec: 30, aspectRatio: "16:9", withVoiceover: false, bgm: true };
    expect(ConstraintsSchema.parse(value)).toEqual(value);
  });

  it("rejects an unknown aspect ratio", () => {
    const value = { durationSec: 30, aspectRatio: "4:3", withVoiceover: false };
    expect(() => ConstraintsSchema.parse(value)).toThrow();
  });

  it("exposes the allowed sets for the UI", () => {
    expect(ALLOWED_DURATIONS).toEqual([15, 30, 45, 60, 120, 180]);
    expect(ALLOWED_ASPECT_RATIOS).toEqual(["16:9", "9:16", "1:1"]);
  });

  it("accepts the new 2m and 3m durations", () => {
    for (const durationSec of [120, 180]) {
      const value = { durationSec, aspectRatio: "16:9", withVoiceover: false };
      expect(ConstraintsSchema.parse(value)).toEqual(value);
    }
  });

  it("accepts a constraints object with a valid voice", () => {
    const value = { durationSec: 30, aspectRatio: "16:9", withVoiceover: true, voice: "Puck" };
    expect(ConstraintsSchema.parse(value)).toEqual(value);
  });

  it("accepts a constraints object with no voice (optional)", () => {
    const value = { durationSec: 30, aspectRatio: "16:9", withVoiceover: true };
    expect(ConstraintsSchema.parse(value)).toEqual(value);
  });

  it("rejects an unknown voice", () => {
    const value = { durationSec: 30, aspectRatio: "16:9", withVoiceover: true, voice: "Nope" };
    expect(() => ConstraintsSchema.parse(value)).toThrow();
  });
});

describe("BriefSchema", () => {
  const valid = {
    product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
    audience: "developers",
    keyMessages: ["fast", "simple"],
    brandHints: { colors: ["#FF0000"], logoUrl: "https://x/logo.png", fonts: ["Inter"] },
    sourceAssets: { images: ["a.png"], videos: [], copy: ["hero text"] },
    constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
  };

  it("accepts a complete brief", () => {
    expect(BriefSchema.parse(valid)).toEqual(valid);
  });

  it("accepts a brief without optional brand hints", () => {
    const { logoUrl, fonts, ...colorsOnly } = valid.brandHints;
    const v = { ...valid, brandHints: { colors: colorsOnly.colors } };
    expect(BriefSchema.parse(v).brandHints.fonts).toBeUndefined();
  });

  it("rejects a brief missing keyMessages", () => {
    const { keyMessages, ...rest } = valid;
    expect(() => BriefSchema.parse(rest)).toThrow();
  });

  it("rejects more than 3 key messages", () => {
    expect(() => BriefSchema.parse({ ...valid, keyMessages: ["a", "b", "c", "d"] })).toThrow();
  });
});

describe("DesignSchema", () => {
  const valid = {
    mood: "energetic",
    palette: [{ name: "primary", hex: "#FF3366" }],
    typography: { heading: "Poppins", body: "Inter" },
    motionStyle: "kinetic captions",
    keyVisuals: [{ description: "product hero", refAssetId: "img-1" }],
    sampleFrames: [{ caption: "Meet Acme", layoutHint: "centered", thumbnailUrl: "t.png" }],
  };

  it("accepts a complete design", () => {
    expect(DesignSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a palette entry missing hex", () => {
    const v = { ...valid, palette: [{ name: "primary" }] };
    expect(() => DesignSchema.parse(v)).toThrow();
  });

  it("allows sample frames without thumbnails", () => {
    const v = { ...valid, sampleFrames: [{ caption: "x", layoutHint: "left" }] };
    expect(DesignSchema.parse(v).sampleFrames[0]!.thumbnailUrl).toBeUndefined();
  });
});

describe("ScriptSchema", () => {
  const valid = {
    totalSec: 30,
    scenes: [
      {
        id: "s1",
        startSec: 0,
        durationSec: 5,
        visual: "logo reveal",
        onScreenText: "Acme",
        narration: "Meet Acme.",
        assetRefs: ["img-1"],
      },
    ],
  };

  it("accepts a complete script", () => {
    expect(ScriptSchema.parse(valid)).toEqual(valid);
  });

  it("requires at least one scene", () => {
    expect(() => ScriptSchema.parse({ totalSec: 30, scenes: [] })).toThrow();
  });

  it("allows scenes without optional narration/onScreenText/assetRefs", () => {
    const v = {
      totalSec: 10,
      scenes: [{ id: "s1", startSec: 0, durationSec: 10, visual: "shot" }],
    };
    expect(ScriptSchema.parse(v).scenes[0]!.narration).toBeUndefined();
  });
});

describe("artifact contract", () => {
  it("lists all artifact kinds", () => {
    expect(ARTIFACT_KINDS).toEqual([
      "brief",
      "design",
      "script",
      "narration",
      "composition",
      "music",
      "subtitles",
      "mp4",
    ]);
  });

  it("has a data schema for every kind", () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(ARTIFACT_DATA_SCHEMAS[kind]).toBeDefined();
    }
  });

  it("validates music artifact data", () => {
    const value = { file: "a1b2.wav", prompt: "cinematic ambient", durationSec: 30 };
    expect(ARTIFACT_DATA_SCHEMAS.music.parse(value)).toEqual(value);
    expect(() => ARTIFACT_DATA_SCHEMAS.music.parse({ file: "x.wav" })).toThrow();
  });

  it("validates a narration data pointer", () => {
    const ok = ARTIFACT_DATA_SCHEMAS.narration.parse({
      totalMs: 12000,
      segments: [{ sceneId: "s1", audioFile: "narration-s1.mp3", startMs: 0, durationMs: 12000 }],
    });
    expect(ok.segments[0]!.audioFile).toBe("narration-s1.mp3");
  });

  it("validates an artifact descriptor with lineage and stale flag", () => {
    const desc = {
      kind: "script",
      version: 2,
      createdAt: "2026-05-29T00:00:00.000Z",
      derivedFrom: [{ kind: "design", version: 1 }],
      stale: false,
    };
    expect(ArtifactDescriptorSchema.parse(desc)).toEqual(desc);
  });

  it("allows a null lineage for root artifacts", () => {
    const desc = {
      kind: "brief",
      version: 1,
      createdAt: "2026-05-29T00:00:00.000Z",
      derivedFrom: null,
      stale: false,
    };
    expect(ArtifactDescriptorSchema.parse(desc).derivedFrom).toBeNull();
  });

  it("defaults composition entry to index.html when omitted", () => {
    const parsed = ARTIFACT_DATA_SCHEMAS.composition.parse({ dir: "composition/" });
    expect(parsed.entry).toBe("index.html");
  });
});

describe("ServerEventSchema", () => {
  it("validates an artifact.created event", () => {
    const e = { type: "artifact.created", kind: "brief", version: 1 };
    expect(ServerEventSchema.parse(e)).toEqual(e);
  });

  it("validates a phase.error event", () => {
    const e = { type: "phase.error", phase: "design", error: "boom" };
    expect(ServerEventSchema.parse(e)).toEqual(e);
  });

  it("parses intent.unhandled events", () => {
    const ev = { type: "intent.unhandled", message: "I can't act on that message right now." };
    expect(ServerEventSchema.parse(ev)).toEqual(ev);
  });

  it("validates a render.progress event", () => {
    const e = { type: "render.progress", percent: 42 };
    expect(ServerEventSchema.parse(e)).toEqual(e);
  });

  it("rejects an unknown event type", () => {
    expect(() => ServerEventSchema.parse({ type: "nope" })).toThrow();
  });
});

describe("Intent", () => {
  it("lists all intents", () => {
    expect(INTENTS).toEqual([
      "new-project",
      "approve",
      "refine",
      "update-brief",
      "revise-back",
      "branch",
      "abort",
      "ask",
    ]);
  });

  it("validates an intent value", () => {
    expect(IntentSchema.parse("approve")).toBe("approve");
    expect(() => IntentSchema.parse("frobnicate")).toThrow();
  });
});

describe("UserMessageSchema", () => {
  it("accepts a first-message payload with text + constraints + uploaded files", () => {
    const v = {
      text: "Make a promo for Acme",
      uploadedFiles: ["uploads/logo.png"],
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
    };
    expect(UserMessageSchema.parse(v)).toEqual(v);
  });

  it("accepts a follow-up message with text only", () => {
    const v = { text: "approve" };
    expect(UserMessageSchema.parse(v)).toEqual(v);
  });

  it("rejects a message missing text", () => {
    expect(() => UserMessageSchema.parse({})).toThrow();
  });

  it("rejects constraints with an invalid aspect ratio", () => {
    const v = {
      text: "hi",
      constraints: { durationSec: 30, aspectRatio: "4:3", withVoiceover: false },
    };
    expect(() => UserMessageSchema.parse(v)).toThrow();
  });
});

describe("AssetRefSchema / UserMessage.assets", () => {
  it("accepts a labeled asset reference", () => {
    const v = { label: "logo", path: "uploads/logo.png", role: "logo" };
    expect(AssetRefSchema.parse(v)).toEqual(v);
  });

  it("rejects an unknown role", () => {
    expect(() => AssetRefSchema.parse({ label: "x", path: "p", role: "banner" })).toThrow();
  });

  it("accepts a message carrying labeled assets", () => {
    const v = {
      text: "Use @logo and @image1",
      uploadedFiles: ["uploads/logo.png", "uploads/a.png"],
      assets: [
        { label: "logo", path: "uploads/logo.png", role: "logo" },
        { label: "image1", path: "uploads/a.png", role: "image" },
      ],
    };
    expect(UserMessageSchema.parse(v)).toEqual(v);
  });
});

describe("barrel export", () => {
  it("re-exports the public schemas and types", () => {
    expect(shared.BriefSchema).toBeDefined();
    expect(shared.DesignSchema).toBeDefined();
    expect(shared.ScriptSchema).toBeDefined();
    expect(shared.ConstraintsSchema).toBeDefined();
    expect(shared.ServerEventSchema).toBeDefined();
    expect(shared.IntentSchema).toBeDefined();
    expect(shared.ARTIFACT_DATA_SCHEMAS).toBeDefined();
    expect(shared.ArtifactDescriptorSchema).toBeDefined();
  });
});
