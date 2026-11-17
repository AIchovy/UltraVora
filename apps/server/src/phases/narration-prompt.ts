// apps/server/src/phases/narration-prompt.ts
import { NARRATION_TAIL_PAD_MS, type NarrationData } from "@ultracreator/shared";

/**
 * How far (seconds) a scene's VISUAL clip may start before its listed
 * data-start so the incoming scene can crossfade over the outgoing one.
 * Must stay well inside the narration tail pad so an early reveal never
 * overlaps the previous scene's speech.
 */
export const SCENE_REVEAL_OVERLAP_SEC = 0.8;

/**
 * Turn the (millisecond) narration timeline into a prompt block for the compose
 * agent, converting to seconds. Returns the block plus the root total duration
 * (seconds, 2dp) so the handler can set both the prompt's "Total duration" line
 * and the root data-duration consistently.
 */
/**
 * Rewrite each scene's startSec/durationSec to the FINAL narration timeline
 * (voiceover stretches scenes to audio length + tail pad). Without this the
 * compose prompt carries two conflicting duration sets — the script's stale
 * plan next to the authoritative narration block — and motion authored to the
 * stale, shorter duration freezes seconds before the scene ends (prod session
 * 45a7b61e: script planned 6s, narration stretched the scene to 7.91s).
 * Scenes without a matching segment pass through unchanged.
 */
export function retimeScenesToNarration<
  T extends { id: string; startSec: number; durationSec: number },
>(scenes: readonly T[], data: NarrationData): T[] {
  const segById = new Map(data.segments.map((seg) => [seg.sceneId, seg]));
  return scenes.map((scene) => {
    const seg = segById.get(scene.id);
    if (!seg) return scene;
    return {
      ...scene,
      startSec: Number((seg.startMs / 1000).toFixed(2)),
      durationSec: Number((seg.durationMs / 1000).toFixed(2)),
    };
  });
}

export function buildNarrationPromptBlock(data: NarrationData): {
  block: string;
  totalDurationSec: string;
} {
  const totalDurationSec = (data.totalMs / 1000).toFixed(2);
  const lines = data.segments.map((seg) => {
    const startSec = (seg.startMs / 1000).toFixed(2);
    const durSec = (seg.durationMs / 1000).toFixed(2);
    const tail = seg.audioFile
      ? ` narration audio "${seg.audioFile}" (add <audio data-track-index="0" data-start="${startSec}" data-duration="${durSec}">)`
      : " (silent)";
    return `- scene ${seg.sceneId}: data-start="${startSec}" data-duration="${durSec}"${tail}`;
  });
  const tailPadSec = (NARRATION_TAIL_PAD_MS / 1000).toFixed(1);
  const block =
    `\n\nNARRATION TIMELINE (authoritative — set the root data-duration to ${totalDurationSec}):\n` +
    `${lines.join("\n")}\n` +
    `Timing rules:\n` +
    `- AUDIO clips: add one per narrated scene with these EXACT data-start/data-duration values. ` +
    `Never shift, trim, or re-time narration audio.\n` +
    `- SCENE visual clips: each scene's listed window is authoritative, with ONE allowed adjustment — ` +
    `you may start a scene's clip up to ${SCENE_REVEAL_OVERLAP_SEC}s before its listed data-start ` +
    `(extending its data-duration by the same amount) so the incoming scene can transition/crossfade ` +
    `over the end of the outgoing one. Never delay a scene past its listed start, and never change ` +
    `where a scene ENDS.\n` +
    `- Each narrated scene's window already ends with ~${tailPadSec}s of silence after the speech ` +
    `(a built-in tail pad). That pad IS the transition window: place the scene-to-scene transition ` +
    `inside it and let the next scene's entrance land during it — don't leave the pad as dead air ` +
    `with a static frame.`;
  return { block, totalDurationSec };
}
