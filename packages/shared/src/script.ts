import { z } from "zod";

export const ChoreographyCueSchema = z.object({
  target: z.string(),
  verb: z.string(),
  timing: z.string(),
  ease: z.string().optional(),
});

function isHardCut(type: string): boolean {
  return /^(?:hard[\s_-]*cut|cut|none)$/i.test(type.trim());
}

export const TransitionDirectionSchema = z.object({
  type: z.string(),
  // A hard cut is instantaneous. Other transitions still need a positive
  // duration so an accidental zero cannot silently turn them into cuts.
  durationSec: z.number().min(0).max(1.5),
  ease: z.string(),
  reason: z.string(),
}).superRefine((transition, ctx) => {
  if (transition.durationSec === 0 && !isHardCut(transition.type)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["durationSec"],
      message: "durationSec may be 0 only for a hard cut",
    });
  }
});

export const SoundEffectCueSchema = z.object({
  type: z.string(),
  atSec: z.number().min(0),
  purpose: z.string(),
  volume: z.number().min(0).max(1).optional(),
});

export const SceneProductionDirectionSchema = z.object({
  sceneId: z.string(),
  concept: z.string(),
  purpose: z.string(),
  moodDirection: z.string(),
  shotType: z.string(),
  cameraMove: z.string(),
  heroFrameAtSec: z.number().min(0),
  depthLayers: z.object({
    background: z.array(z.string()).min(1),
    midground: z.array(z.string()).min(1),
    foreground: z.array(z.string()).min(1),
  }),
  choreography: z.array(ChoreographyCueSchema).min(1),
  transitionOut: TransitionDirectionSchema.optional(),
  effectSlots: z.array(z.string()),
  sfxCues: z.array(SoundEffectCueSchema),
});

/**
 * Persistent director/storyboard decisions shared by script, compose and the
 * visual-quality pass. Optional keeps artifacts made before this field existed
 * readable; the script agent is required to populate it for new generations.
 */
export const ProductionPlanSchema = z.object({
  rhythmPattern: z.string(),
  energyCurve: z.array(z.object({
    sceneId: z.string(),
    level: z.enum(["low", "medium", "high", "peak"]),
    purpose: z.string(),
  })).min(1),
  primaryTransition: z.string(),
  accentTransitions: z.array(z.string()).max(2),
  recurringMotifs: z.array(z.string()).min(1),
  soundDirection: z.string(),
  scenes: z.array(SceneProductionDirectionSchema).min(1),
});

export const SceneSchema = z.object({
  id: z.string(),
  startSec: z.number().min(0),
  durationSec: z.number().positive(),
  visual: z.string(),
  onScreenText: z.string().optional(),
  narration: z.string().optional(),
  assetRefs: z.array(z.string()).optional(),
});

export const ScriptSchema = z.object({
  totalSec: z.number().positive(),
  scenes: z.array(SceneSchema).min(1),
  productionPlan: ProductionPlanSchema.optional(),
});

export type Scene = z.infer<typeof SceneSchema>;
export type ProductionPlan = z.infer<typeof ProductionPlanSchema>;
export type SceneProductionDirection = z.infer<typeof SceneProductionDirectionSchema>;
export type Script = z.infer<typeof ScriptSchema>;
