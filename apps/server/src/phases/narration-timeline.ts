// apps/server/src/phases/narration-timeline.ts
import { NARRATION_TAIL_PAD_MS, type NarrationData } from "@ultracreator/shared";

export interface RetimingScene {
  id: string;
  durationSec: number;
}

export interface RetimingOptions {
  /** Silence added after each narrated scene's audio. Default NARRATION_TAIL_PAD_MS. */
  tailPadMs?: number;
  /** Floor for a narrated scene's duration. Default 2000ms. */
  minSceneMs?: number;
}

/**
 * Build the authoritative narration timeline. Narrated scenes (those whose id
 * appears in `audioDurationMsBySceneId`) keep their planned duration when the
 * read is shorter, leaving intentional breathing room. A long read can still
 * extend the scene to `audioDurationMs + tailPad`; `minSceneMs` remains a final
 * floor. Silent scenes keep their planned duration. Starts are cumulative.
 */
export function computeNarrationTimeline(
  scenes: RetimingScene[],
  audioDurationMsBySceneId: Record<string, number>,
  opts: RetimingOptions = {},
): NarrationData {
  const tailPadMs = opts.tailPadMs ?? NARRATION_TAIL_PAD_MS;
  const minSceneMs = opts.minSceneMs ?? 2000;

  let cursor = 0;
  const segments = scenes.map((scene) => {
    const audioMs = audioDurationMsBySceneId[scene.id];
    const narrated = audioMs !== undefined;
    const durationMs = narrated
      ? Math.max(Math.round(scene.durationSec * 1000), audioMs + tailPadMs, minSceneMs)
      : Math.round(scene.durationSec * 1000);
    const startMs = cursor;
    cursor += durationMs;
    return narrated
      ? { sceneId: scene.id, audioFile: `narration-${scene.id}.wav`, startMs, durationMs }
      : { sceneId: scene.id, startMs, durationMs };
  });

  return { totalMs: cursor, segments };
}
