import { z } from "zod";
import { VoiceSchema } from "./voices.js";

export const ALLOWED_DURATIONS = [15, 30, 45, 60, 120, 180] as const;
export const ALLOWED_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;

/** Output pixel dimensions per aspect ratio (the render target; not tier-gated). */
export const RESOLUTIONS: Record<(typeof ALLOWED_ASPECT_RATIOS)[number], { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

export function resolutionFor(aspect: (typeof ALLOWED_ASPECT_RATIOS)[number]): { width: number; height: number } {
  return RESOLUTIONS[aspect];
}

/** "1920 × 1080" — for showing the output resolution in the UI. */
export function resolutionLabel(aspect: (typeof ALLOWED_ASPECT_RATIOS)[number]): string {
  const { width, height } = RESOLUTIONS[aspect];
  return `${width} × ${height}`;
}

export const DurationSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(45),
  z.literal(60),
  z.literal(120),
  z.literal(180),
]);

export const AspectRatioSchema = z.enum(ALLOWED_ASPECT_RATIOS);

export const ConstraintsSchema = z.object({
  durationSec: DurationSchema,
  aspectRatio: AspectRatioSchema,
  withVoiceover: z.boolean(),
  /** Render verbatim subtitles (CC) for the narration. Only meaningful with voiceover. */
  subtitles: z.boolean().optional(),
  /** Generate AI background music and mix it under the video. */
  bgm: z.boolean().optional(),
  /** Gemini prebuilt voice for the narration. Absent → backend default (Kore). */
  voice: VoiceSchema.optional(),
});

export type Duration = z.infer<typeof DurationSchema>;
export type AspectRatio = z.infer<typeof AspectRatioSchema>;
export type Constraints = z.infer<typeof ConstraintsSchema>;
