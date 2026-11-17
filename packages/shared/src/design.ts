import { z } from "zod";

export const DesignSchema = z.object({
  mood: z.string(),
  palette: z.array(z.object({ name: z.string(), hex: z.string() })).min(1),
  /**
   * Role assignments for the palette — which hex plays background, foreground,
   * accent (and optionally an elevated surface). Without roles the composer
   * has to guess which color is the background.
   */
  colorRoles: z
    .object({
      background: z.string(),
      foreground: z.string(),
      accent: z.string(),
      surface: z.string().optional(),
    })
    .optional(),
  typography: z.object({ heading: z.string(), body: z.string() }),
  /** Video-scale type spec, e.g. display "96px 900", body "24px 400". */
  typeScale: z
    .object({
      display: z.string(),
      heading: z.string(),
      body: z.string(),
      caption: z.string().optional(),
    })
    .optional(),
  motionStyle: z.string(),
  /** Structured motion language: energy level, ease family, guiding principles. */
  motion: z
    .object({
      energy: z.string(),
      easing: z.string(),
      principles: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * One reusable style suffix appended to every generated-image prompt so all
   * AI imagery in the video shares a look (e.g. "flat vector illustration,
   * deep navy background, coral accents, soft studio light").
   */
  imageStyle: z.string().optional(),
  keyVisuals: z.array(
    z.object({ description: z.string(), refAssetId: z.string().optional() }),
  ),
  sampleFrames: z.array(
    z.object({
      caption: z.string(),
      layoutHint: z.string(),
      thumbnailUrl: z.string().optional(),
    }),
  ),
});

export type Design = z.infer<typeof DesignSchema>;
