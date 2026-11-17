import { z } from "zod";
import { ConstraintsSchema } from "./constraints.js";

export const BriefSchema = z.object({
  product: z.object({
    name: z.string().min(1),
    tagline: z.string(),
    description: z.string(),
    category: z.string(),
  }),
  audience: z.string(),
  keyMessages: z.array(z.string()).min(1).max(3),
  brandHints: z.object({
    colors: z.array(z.string()),
    logoUrl: z.string().optional(),
    logoFile: z.string().optional(),
    fonts: z.array(z.string()).optional(),
  }),
  sourceAssets: z.object({
    images: z.array(z.string()),
    videos: z.array(z.string()),
    copy: z.array(z.string()),
  }),
  /**
   * The user's aesthetic/style wording, verbatim ("minimal", "like an Apple
   * ad", "playful neon"). Downstream phases honor it; without this field the
   * user's style intent survives only one phase hop.
   */
  styleIntent: z.string().optional(),
  constraints: ConstraintsSchema,
});

export type Brief = z.infer<typeof BriefSchema>;
