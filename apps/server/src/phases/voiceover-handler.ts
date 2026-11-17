import { join } from "node:path";
import type { Brief, Design, LineageRef, PhaseId, Script, ServerEvent } from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { TTSResult } from "../providers/types.js";
import { describeError, isTransientNetworkError } from "../errors.js";
import { sleepUnlessAborted } from "../retry.js";
import { computeNarrationTimeline } from "./narration-timeline.js";

/**
 * One compact sentence of delivery direction from the design's free-text mood
 * and motion style. Truncated defensively — these are LLM-authored strings.
 */
export function buildStyleInstruction(mood: string, motionStyle: string): string | undefined {
  const clean = (s: string) => s.trim().replace(/\s+/g, " ").slice(0, 120);
  const m = clean(mood);
  const motion = clean(motionStyle);
  if (!m && !motion) return undefined;
  const parts = [`Say in a ${m || "confident"} tone`];
  if (motion) parts.push(`paced to suit a ${motion} promo video`);
  return parts.join(", ");
}

export interface VoiceoverPhaseHandlerOptions {
  providers: ProviderRegistry;
  /** Optional explicit provider id; defaults to the first registered TTS provider. */
  providerId?: string;
  /** Retry policy for transient provider failures (network blips, 429/5xx). */
  retry?: { attempts?: number; baseDelayMs?: number };
}

export class VoiceoverPhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "voiceover";
  constructor(private opts: VoiceoverPhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    const scriptEnv = await ctx.artifacts.get<Script>(ctx.sessionId, "script");
    if (!scriptEnv) throw new Error("voiceover phase requires a script artifact, none found");

    const briefEnv = await ctx.artifacts.get<Brief>(ctx.sessionId, "brief");
    const voice = briefEnv?.data.constraints.voice; // undefined → provider default

    // Delivery direction from the design board (best-effort — narration works
    // without a design). Without it every video gets the provider's default
    // neutral read regardless of the video's mood.
    const designEnv = await ctx.artifacts.get<Design>(ctx.sessionId, "design");
    const styleInstruction = designEnv
      ? buildStyleInstruction(designEnv.data.mood, designEnv.data.motionStyle)
      : undefined;

    const scenes = scriptEnv.data.scenes;
    const narrated = scenes.filter(
      (s) => typeof s.narration === "string" && s.narration.trim().length > 0,
    );

    if (narrated.length === 0) {
      yield {
        type: "phase.progress",
        phase: this.phase,
        message: "Script has no narration; skipping TTS.",
      };
      return;
    }

    // Eager get so a missing-provider error surfaces BEFORE we yield progress.
    const provider = this.opts.providers.require("tts", this.opts.providerId);

    const composition = ctx.workspaces.paths(ctx.sessionId).composition;
    const audioDurationMsBySceneId: Record<string, number> = {};

    const maxAttempts = this.opts.retry?.attempts ?? 3;
    const baseDelayMs = this.opts.retry?.baseDelayMs ?? 1500;

    for (const scene of narrated) {
      if (ctx.signal.aborted) throw new Error("Aborted");
      yield {
        type: "phase.progress",
        phase: this.phase,
        message: `Synthesizing narration for scene ${scene.id} via ${provider.id} provider…`,
      };
      const outputPath = join(composition, `narration-${scene.id}.wav`);
      let result: TTSResult;
      for (let attempt = 1; ; attempt++) {
        try {
          result = await provider.synthesize({
            text: scene.narration!.trim(),
            outputPath,
            voice,
            styleInstruction,
            signal: ctx.signal,
          });
          break;
        } catch (err) {
          if (attempt >= maxAttempts || ctx.signal.aborted || !isTransientNetworkError(err)) {
            throw err;
          }
          yield {
            type: "phase.progress",
            phase: this.phase,
            message: `Transient error on scene ${scene.id}: ${describeError(err)}. Retrying (attempt ${attempt + 1}/${maxAttempts})…`,
          };
          await sleepUnlessAborted(baseDelayMs * 2 ** (attempt - 1), ctx.signal);
        }
      }
      audioDurationMsBySceneId[scene.id] = result.durationMs;
    }

    const timeline = computeNarrationTimeline(
      scenes.map((s) => ({ id: s.id, durationSec: s.durationSec })),
      audioDurationMsBySceneId,
    );

    const derivedFrom: LineageRef[] = [{ kind: "script", version: scriptEnv.version }];
    await ctx.artifacts.put(ctx.sessionId, "narration", timeline, { derivedFrom });
  }
}
