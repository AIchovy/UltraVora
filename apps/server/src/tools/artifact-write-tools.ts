import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  BriefSchema,
  DesignSchema,
  ScriptSchema,
  type Constraints,
  type LineageRef,
  type Script,
} from "@ultracreator/shared";
import type { ArtifactStore } from "../artifacts/artifact-store.js";

export interface ArtifactWriteToolOptions {
  sessionId: string;
  artifacts: ArtifactStore;
  derivedFrom?: LineageRef[];
  /**
   * The user's UI-selected constraints from the initial message. Only used by
   * write_brief: these are authoritative user inputs (voice, duration, aspect,
   * the voiceover/subtitles/bgm toggles), so we stamp them onto the brief here
   * instead of trusting the LLM to copy them through write_brief. A field that
   * isn't advertised in `briefParameters` (notably `voice`) can never survive
   * the round-trip otherwise — that was the "picked Achird, got Kore" bug.
   */
  userConstraints?: Constraints;
}

const briefParameters = Type.Object({
  product: Type.Object({
    name: Type.String(),
    tagline: Type.String(),
    description: Type.String(),
    category: Type.String(),
  }),
  audience: Type.String(),
  keyMessages: Type.Array(Type.String()),
  brandHints: Type.Object({
    colors: Type.Array(Type.String()),
    logoUrl: Type.Optional(Type.String()),
    logoFile: Type.Optional(Type.String()),
    fonts: Type.Optional(Type.Array(Type.String())),
  }),
  sourceAssets: Type.Object({
    images: Type.Array(Type.String()),
    videos: Type.Array(Type.String()),
    copy: Type.Array(Type.String()),
  }),
  styleIntent: Type.Optional(
    Type.String({
      description:
        "The user's aesthetic/style wording, verbatim (e.g. 'minimal', 'like an Apple ad'). " +
        "Omit when the user expressed no style preference.",
    }),
  ),
  constraints: Type.Object({
    durationSec: Type.Number(),
    aspectRatio: Type.String(),
    withVoiceover: Type.Boolean(),
    // Optional toggles the user sets in the UI. They must be advertised here so
    // the LLM emits them when calling write_brief; otherwise they are silently
    // dropped and the compose phase skips captions / background music.
    subtitles: Type.Optional(Type.Boolean()),
    bgm: Type.Optional(Type.Boolean()),
  }),
});

const designParameters = Type.Object({
  mood: Type.String(),
  palette: Type.Array(Type.Object({ name: Type.String(), hex: Type.String() })),
  colorRoles: Type.Object({
    background: Type.String({ description: "Hex of the scene background color." }),
    foreground: Type.String({ description: "Hex of the primary text color." }),
    accent: Type.String({ description: "Hex of the single accent hue." }),
    surface: Type.Optional(Type.String({ description: "Hex for elevated cards/surfaces." })),
  }),
  typography: Type.Object({ heading: Type.String(), body: Type.String() }),
  typeScale: Type.Optional(Type.Object({
    display: Type.String({ description: 'e.g. "96px 900"' }),
    heading: Type.String({ description: 'e.g. "64px 800"' }),
    body: Type.String({ description: 'e.g. "24px 400"' }),
    caption: Type.Optional(Type.String()),
  })),
  motionStyle: Type.String(),
  motion: Type.Optional(Type.Object({
    energy: Type.String({ description: "calm | confident | energetic | frenetic" }),
    easing: Type.String({ description: 'GSAP ease family, e.g. "power3.out entrances, expo.out hero"' }),
    principles: Type.Optional(Type.Array(Type.String())),
  })),
  imageStyle: Type.Optional(Type.String({
    description:
      "One reusable style suffix for ALL generated imagery (medium, palette words, lighting), " +
      "so every AI image in the video shares a look.",
  })),
  keyVisuals: Type.Array(Type.Object({
    description: Type.String(),
    refAssetId: Type.Optional(Type.String()),
  })),
  sampleFrames: Type.Array(Type.Object({
    caption: Type.String(),
    layoutHint: Type.String(),
    thumbnailUrl: Type.Optional(Type.String()),
  })),
});

const scriptParameters = Type.Object({
  totalSec: Type.Number(),
  scenes: Type.Array(Type.Object({
    id: Type.String(),
    startSec: Type.Number(),
    durationSec: Type.Number(),
    visual: Type.String(),
    onScreenText: Type.Optional(Type.String()),
    narration: Type.Optional(Type.String()),
    assetRefs: Type.Optional(Type.Array(Type.String())),
  })),
  productionPlan: Type.Optional(Type.Object({
    rhythmPattern: Type.String({ description: "Named pacing arc, e.g. hook-PUNCH-breathe-PEAK-CTA." }),
    energyCurve: Type.Array(Type.Object({
      sceneId: Type.String(),
      level: Type.Union([
        Type.String({ description: "Use exactly low, medium, high, or peak." }),
        Type.Number({
          minimum: 0,
          maximum: 10,
          description: "A numeric intensity score; it will be normalized to low/medium/high/peak.",
        }),
      ]),
      purpose: Type.String(),
    })),
    primaryTransition: Type.String(),
    accentTransitions: Type.Array(Type.String(), { maxItems: 2 }),
    recurringMotifs: Type.Array(Type.String()),
    soundDirection: Type.String(),
    scenes: Type.Array(Type.Object({
      sceneId: Type.String(),
      concept: Type.String(),
      purpose: Type.String(),
      moodDirection: Type.String(),
      shotType: Type.String(),
      cameraMove: Type.String(),
      heroFrameAtSec: Type.Number({ description: "Seconds from this scene's start." }),
      depthLayers: Type.Object({
        background: Type.Array(Type.String()),
        midground: Type.Array(Type.String()),
        foreground: Type.Array(Type.String()),
      }),
      choreography: Type.Array(Type.Object({
        target: Type.String(),
        verb: Type.String(),
        timing: Type.String(),
        ease: Type.Optional(Type.String()),
      })),
      transitionOut: Type.Optional(Type.Object({
        type: Type.String(),
        durationSec: Type.Number({
          minimum: 0,
          maximum: 1.5,
          description: "Seconds. Use 0 only for hard cut/cut/none.",
        }),
        ease: Type.String(),
        reason: Type.String(),
      })),
      effectSlots: Type.Array(Type.String()),
      sfxCues: Type.Array(Type.Object({
        type: Type.String(),
        atSec: Type.Number({ description: "Seconds from this scene's start." }),
        purpose: Type.String(),
        volume: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      })),
    })),
  })),
});

type ScriptParameters = Static<typeof scriptParameters>;
type EnergyLevel = "low" | "medium" | "high" | "peak";

/**
 * Gemini often expresses an energy curve as 1-5 scores even when the prompt
 * asks for labels. Accept that harmless representation at the tool boundary
 * and persist the canonical vocabulary consumed by Compose.
 */
function normalizeEnergyLevel(level: string | number): EnergyLevel | string {
  if (typeof level === "number") {
    // Also handle normalized 0..1 scores. Integer 1 remains the low end of
    // the much more common 1-5 scale rather than being mistaken for 100%.
    if (level >= 0 && level < 1) {
      if (level <= 0.25) return "low";
      if (level <= 0.55) return "medium";
      if (level <= 0.85) return "high";
      return "peak";
    }
    if (level <= 1) return "low";
    if (level <= 2) return "medium";
    if (level <= 4) return "high";
    return "peak";
  }

  const normalized = level.trim().toLowerCase();
  const numeric = Number(normalized);
  if (normalized !== "" && Number.isFinite(numeric)) return normalizeEnergyLevel(numeric);
  if (/peak|max(?:imum)?|climax/.test(normalized)) return "peak";
  if (/high|energetic|intense/.test(normalized)) return "high";
  if (/medium|moderate|mid/.test(normalized)) return "medium";
  if (/low|calm|quiet/.test(normalized)) return "low";
  return normalized;
}

function normalizeScriptParameters(params: ScriptParameters): unknown {
  if (!params.productionPlan) return params;
  return {
    ...params,
    productionPlan: {
      ...params.productionPlan,
      energyCurve: params.productionPlan.energyCurve.map((point) => ({
        ...point,
        level: normalizeEnergyLevel(point.level),
      })),
    },
  };
}

export function makeWriteBriefTool(opts: ArtifactWriteToolOptions): AgentTool<typeof briefParameters> {
  return {
    name: "write_brief",
    label: "Write Brief",
    description:
      "Persist the research brief for this session. Call this exactly once when the brief is final.",
    parameters: briefParameters,
    execute: async (_callId, params) => {
      const data = BriefSchema.parse(params);
      // The user's explicit UI choices are authoritative and win over whatever
      // the LLM emitted (or, for `voice`, could not emit at all). ArtifactStore
      // re-validates on put, so the merged constraints stay schema-checked.
      const brief = opts.userConstraints
        ? { ...data, constraints: { ...data.constraints, ...opts.userConstraints } }
        : data;
      const env = await opts.artifacts.put(opts.sessionId, "brief", brief, {
        derivedFrom: opts.derivedFrom,
      });
      return {
        content: [{ type: "text", text: `Wrote brief v${env.version}.` }],
        details: { kind: "brief", version: env.version },
      };
    },
  };
}

export function makeWriteDesignTool(opts: ArtifactWriteToolOptions): AgentTool<typeof designParameters> {
  return {
    name: "write_design",
    label: "Write Design",
    description: "Persist the final design board for this session.",
    parameters: designParameters,
    execute: async (_callId, params) => {
      const data = DesignSchema.parse(params);
      const env = await opts.artifacts.put(opts.sessionId, "design", data, {
        derivedFrom: opts.derivedFrom,
      });
      return {
        content: [{ type: "text", text: `Wrote design v${env.version}.` }],
        details: { kind: "design", version: env.version },
      };
    },
  };
}

/** Average TTS speaking rate used to budget narration against scene windows. */
export const TTS_WORDS_PER_SEC = 2.4;
/** A scene's spoken length may deviate this much from its window before we reject. */
const SCENE_BUDGET_TOLERANCE = 0.35;
/** The estimated narration total may deviate this much from totalSec before we reject. */
const TOTAL_BUDGET_TOLERANCE = 0.25;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * The voiceover phase re-times every narrated scene to speech-length + pad, so
 * narration that overruns its window silently wrecks the script's pacing. A
 * shorter read is fine: the voiceover timeline preserves the planned scene
 * duration and uses the remainder as intentional breathing room.
 */
function checkNarrationBudget(data: { totalSec: number; scenes: Array<{ id: string; durationSec: number; narration?: string }> }): void {
  const narrated = data.scenes.filter((s) => s.narration && s.narration.trim().length > 0);
  if (narrated.length === 0) return;

  const offenders: string[] = [];
  let estimatedTotalSec = 0;
  for (const scene of data.scenes) {
    const hasNarration = !!scene.narration && scene.narration.trim().length > 0;
    if (!hasNarration) {
      estimatedTotalSec += scene.durationSec;
      continue;
    }
    const spokenSec = countWords(scene.narration!) / TTS_WORDS_PER_SEC;
    estimatedTotalSec += spokenSec;
    const overrun = (spokenSec - scene.durationSec) / scene.durationSec;
    if (overrun > SCENE_BUDGET_TOLERANCE) {
      const targetWords = Math.round(scene.durationSec * TTS_WORDS_PER_SEC);
      offenders.push(
        `scene ${scene.id}: ${countWords(scene.narration!)} words ≈ ${spokenSec.toFixed(1)}s of speech ` +
          `vs a ${scene.durationSec}s window — use no more than ~${targetWords} words for this scene ` +
          `(TTS speaks ~${TTS_WORDS_PER_SEC} words/sec)`,
      );
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Narration does not fit the scene windows (speech is re-timed to audio length, so a mismatch ` +
        `destroys the planned pacing):\n${offenders.map((o) => `- ${o}`).join("\n")}`,
    );
  }
  const totalOverrun = (estimatedTotalSec - data.totalSec) / data.totalSec;
  if (totalOverrun > TOTAL_BUDGET_TOLERANCE) {
    throw new Error(
      `Estimated spoken runtime ${estimatedTotalSec.toFixed(1)}s exceeds totalSec ${data.totalSec}s by ` +
        `>${Math.round(TOTAL_BUDGET_TOLERANCE * 100)}%. Rebalance narration lengths so the video runs the requested duration.`,
    );
  }
}

export interface WriteScriptToolOptions extends ArtifactWriteToolOptions {
  /** The user's requested video duration; scripts that drift from it are rejected. */
  expectedDurationSec?: number;
}

const SCRIPT_TIMING_TOLERANCE_SEC = 0.05;

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

/** Validate editorial invariants that the schema cannot express. */
function checkProductionPlan(data: Script): void {
  const plan = data.productionPlan;
  if (!plan) return; // ScriptSchema stays backwards-compatible with legacy artifacts.
  const sceneIds = data.scenes.map((scene) => scene.id);
  const sceneIdSet = new Set(sceneIds);
  const directedIds = plan.scenes.map((scene) => scene.sceneId);
  const duplicateDirections = duplicateValues(directedIds);
  const missing = sceneIds.filter((id) => !directedIds.includes(id));
  const unknown = directedIds.filter((id) => !sceneIdSet.has(id));
  const outOfOrder = directedIds.length === sceneIds.length && directedIds.some(
    (id, index) => id !== sceneIds[index],
  );
  if (missing.length || unknown.length || duplicateDirections.length || outOfOrder) {
    throw new Error(
      `productionPlan.scenes must map one-to-one to script scenes` +
        `${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
        `${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}` +
        `${duplicateDirections.length ? `; duplicates: ${duplicateDirections.join(", ")}` : ""}` +
        `${outOfOrder ? "; directions must follow script scene order" : ""}`,
    );
  }

  let cursor = 0;
  for (const scene of data.scenes) {
    if (Math.abs(scene.startSec - cursor) > SCRIPT_TIMING_TOLERANCE_SEC) {
      throw new Error(
        `Script scenes must form one continuous edit with no gaps/overlaps; scene ${scene.id} ` +
          `starts at ${scene.startSec}s but should start at ${cursor}s.`,
      );
    }
    cursor = scene.startSec + scene.durationSec;
  }
  if (Math.abs(cursor - data.totalSec) > SCRIPT_TIMING_TOLERANCE_SEC) {
    throw new Error(
      `Script scene windows end at ${cursor}s but totalSec is ${data.totalSec}s; ` +
        `the edit must cover the complete runtime.`,
    );
  }

  const energyIds = plan.energyCurve.map((point) => point.sceneId);
  const missingEnergy = sceneIds.filter((id) => !energyIds.includes(id));
  const unknownEnergy = energyIds.filter((id) => !sceneIdSet.has(id));
  const duplicateEnergy = duplicateValues(energyIds);
  const energyOutOfOrder = energyIds.length === sceneIds.length && energyIds.some(
    (id, index) => id !== sceneIds[index],
  );
  if (missingEnergy.length || unknownEnergy.length || duplicateEnergy.length || energyOutOfOrder) {
    throw new Error(
      `productionPlan.energyCurve must map one-to-one to script scenes` +
        `${missingEnergy.length ? `; missing: ${missingEnergy.join(", ")}` : ""}` +
        `${unknownEnergy.length ? `; unknown: ${unknownEnergy.join(", ")}` : ""}` +
        `${duplicateEnergy.length ? `; duplicates: ${duplicateEnergy.join(", ")}` : ""}` +
        `${energyOutOfOrder ? "; energy points must follow script scene order" : ""}`,
    );
  }

  const allowedTransitions = new Set(
    [plan.primaryTransition, ...plan.accentTransitions].map((value) => value.trim().toLowerCase()),
  );
  const nonFinalDirections = plan.scenes.slice(0, -1);
  const finalDirection = plan.scenes.at(-1)!;
  const missingTransitions = nonFinalDirections
    .filter((direction) => !direction.transitionOut)
    .map((direction) => direction.sceneId);
  if (missingTransitions.length > 0 || finalDirection.transitionOut) {
    throw new Error(
      `Every non-final productionPlan scene needs transitionOut and the final scene must omit it` +
        `${missingTransitions.length ? `; missing: ${missingTransitions.join(", ")}` : ""}` +
        `${finalDirection.transitionOut ? `; final scene ${finalDirection.sceneId} has transitionOut` : ""}`,
    );
  }
  const undeclaredTransitions = nonFinalDirections.flatMap((direction) => {
    const type = direction.transitionOut!.type.trim().toLowerCase();
    return allowedTransitions.has(type) ? [] : [`${direction.sceneId}:${direction.transitionOut!.type}`];
  });
  if (undeclaredTransitions.length > 0) {
    throw new Error(
      `Scene transitions must use primaryTransition or accentTransitions; undeclared: ` +
        undeclaredTransitions.join(", "),
    );
  }
  if (nonFinalDirections.length > 0) {
    const primary = plan.primaryTransition.trim().toLowerCase();
    const primaryCount = nonFinalDirections.filter(
      (direction) => direction.transitionOut!.type.trim().toLowerCase() === primary,
    ).length;
    const target = Math.max(1, Math.round(nonFinalDirections.length * 0.65));
    if (primaryCount < target) {
      throw new Error(
        `primaryTransition must carry the edit (about 60-70% of handoffs); ` +
          `found ${primaryCount}/${nonFinalDirections.length}, need at least ${target}.`,
      );
    }
  }
}

export function makeWriteScriptTool(opts: WriteScriptToolOptions): AgentTool<typeof scriptParameters> {
  return {
    name: "write_script",
    label: "Write Script",
    description: "Persist the final scene-by-scene script for this session.",
    parameters: scriptParameters,
    execute: async (_callId, params) => {
      const data = ScriptSchema.parse(normalizeScriptParameters(params));
      if (
        opts.expectedDurationSec !== undefined &&
        Math.abs(data.totalSec - opts.expectedDurationSec) > 0.5
      ) {
        throw new Error(
          `totalSec ${data.totalSec} does not match the requested video duration ` +
            `${opts.expectedDurationSec}s. The total duration MUST equal the brief's durationSec.`,
        );
      }
      checkNarrationBudget(data);
      if (data.productionPlan) {
        checkProductionPlan(data);
        for (const direction of data.productionPlan.scenes) {
          const scene = data.scenes.find((item) => item.id === direction.sceneId)!;
          if (direction.heroFrameAtSec >= scene.durationSec) {
            throw new Error(
              `productionPlan scene ${scene.id} heroFrameAtSec must be inside its ` +
                `${scene.durationSec}s scene window`,
            );
          }
          const badCue = direction.sfxCues.find((cue) => cue.atSec >= scene.durationSec);
          if (badCue) {
            throw new Error(
              `productionPlan scene ${scene.id} SFX cue at ${badCue.atSec}s must be inside its ` +
                `${scene.durationSec}s scene window`,
            );
          }
        }
        const cueCount = data.productionPlan.scenes.reduce(
          (total, direction) => total + direction.sfxCues.length, 0,
        );
        if (cueCount > 6) {
          throw new Error(`productionPlan contains ${cueCount} SFX cues; the commercial mix allows at most 6`);
        }
      }
      const env = await opts.artifacts.put(opts.sessionId, "script", data, {
        derivedFrom: opts.derivedFrom,
      });
      return {
        content: [{ type: "text", text: `Wrote script v${env.version}.` }],
        details: { kind: "script", version: env.version },
      };
    },
  };
}
