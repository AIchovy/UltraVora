import { z } from "zod";
import { BriefSchema } from "./brief.js";
import { DesignSchema } from "./design.js";
import { ScriptSchema } from "./script.js";

export const ARTIFACT_KINDS = [
  "brief",
  "design",
  "script",
  "narration",
  "composition",
  "music",
  "subtitles",
  "mp4",
] as const;

export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/**
 * Silence held at the END of each narrated scene, after its TTS audio finishes,
 * before the next scene begins. This is the breathing room between consecutive
 * voice lines (a normal scene's voice-to-voice gap equals this value). It is the
 * single source of truth shared by the narration timeline (which adds it to each
 * narrated scene's duration) and the subtitle builder (which subtracts it to find
 * the spoken window), so the two never drift.
 */
export const NARRATION_TAIL_PAD_MS = 1000;

// File-pointer artifacts: data is a small descriptor, the real payload is on disk.
export const NarrationSegmentSchema = z.object({
  sceneId: z.string(),
  audioFile: z.string().optional(), // bare filename in the composition dir; absent for silent scenes
  startMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
});
export type NarrationSegment = z.infer<typeof NarrationSegmentSchema>;

export const NarrationDataSchema = z.object({
  totalMs: z.number().nonnegative(),
  segments: z.array(NarrationSegmentSchema),
});
export type NarrationData = z.infer<typeof NarrationDataSchema>;

export const CompositionDataSchema = z.object({
  dir: z.string(), // relative path to the hyperframes project dir
  entry: z.string().default("index.html"),
  quality: z.object({
    commercialScore: z.number().min(0).max(100),
    summary: z.string(),
    passed: z.boolean(),
    remainingIssues: z.array(z.object({
      sceneId: z.string(),
      category: z.string(),
      severity: z.enum(["high", "medium"]),
      note: z.string(),
      fix: z.string(),
    })),
    reviewCount: z.number().int().positive().optional(),
    scoreHistory: z.array(z.number().min(0).max(100)).optional(),
    sampledFrames: z.array(z.object({
      sceneId: z.string(),
      timeSec: z.number().nonnegative(),
      moment: z.enum(["build", "hero", "resolve"]),
    })).optional(),
  }).optional(),
});
export type CompositionData = z.infer<typeof CompositionDataSchema>;

export const MusicDataSchema = z.object({
  file: z.string(), // bare filename in the composition dir
  prompt: z.string(),
  durationSec: z.number().nonnegative(),
  analysisFile: z.string().optional(),
  bpm: z.number().positive().optional(),
  beatTimesSec: z.array(z.number().nonnegative()).optional(),
});
export type MusicData = z.infer<typeof MusicDataSchema>;

export const Mp4DataSchema = z.object({
  path: z.string(),
  durationSec: z.number().nonnegative().optional(),
});
export type Mp4Data = z.infer<typeof Mp4DataSchema>;

export const SubtitleSegmentSchema = z
  .object({
    sceneId: z.string(),
    text: z.string().min(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
  })
  .refine((s) => s.endMs > s.startMs, { message: "endMs must be greater than startMs" });
export type SubtitleSegment = z.infer<typeof SubtitleSegmentSchema>;

export const SubtitlesDataSchema = z.object({
  language: z.string().default("en"),
  srtPath: z.string(), // workspace-root-relative, e.g. "output/<id>.srt"
  segments: z.array(SubtitleSegmentSchema),
});
export type SubtitlesData = z.infer<typeof SubtitlesDataSchema>;

export const ARTIFACT_DATA_SCHEMAS = {
  brief: BriefSchema,
  design: DesignSchema,
  script: ScriptSchema,
  narration: NarrationDataSchema,
  composition: CompositionDataSchema,
  music: MusicDataSchema,
  subtitles: SubtitlesDataSchema,
  mp4: Mp4DataSchema,
} as const;

export const LineageRefSchema = z.object({
  kind: ArtifactKindSchema,
  version: z.number().int().positive(),
});

export const ArtifactDescriptorSchema = z.object({
  kind: ArtifactKindSchema,
  version: z.number().int().positive(),
  createdAt: z.string(),
  derivedFrom: z.array(LineageRefSchema).nullable(),
  stale: z.boolean(),
});

export type LineageRef = z.infer<typeof LineageRefSchema>;
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>;

// The envelope returned for each artifact version (persisted in the artifacts table; media payloads referenced by relative path inside data).
export interface ArtifactEnvelope<T = unknown> {
  kind: ArtifactKind;
  version: number;
  createdAt: string;
  derivedFrom: LineageRef[] | null;
  data: T;
}
