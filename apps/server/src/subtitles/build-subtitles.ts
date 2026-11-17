import {
  NARRATION_TAIL_PAD_MS,
  type NarrationData,
  type Scene,
  type SubtitleSegment,
} from "@ultracreator/shared";

const MAX_WORDS = 10;

/** Split one scene's narration into short caption lines. */
function splitIntoLines(narration: string): string[] {
  const sentences = narration
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const lines: string[] = [];
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    if (words.length <= MAX_WORDS) {
      lines.push(sentence);
    } else {
      for (let i = 0; i < words.length; i += MAX_WORDS) {
        lines.push(words.slice(i, i + MAX_WORDS).join(" "));
      }
    }
  }
  return lines;
}

/**
 * Derive caption segments purely from the script narration text and the
 * authoritative narration timeline. Narrated scenes only (segments with an
 * audioFile); silent and blank-narration scenes produce nothing.
 */
export function buildSubtitles(scenes: Scene[], narration: NarrationData): SubtitleSegment[] {
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const out: SubtitleSegment[] = [];

  for (const seg of narration.segments) {
    if (!seg.audioFile) continue; // silent scene
    const scene = sceneById.get(seg.sceneId);
    const text = scene?.narration?.trim();
    if (!text) continue;

    const lines = splitIntoLines(text);
    if (lines.length === 0) continue;

    const spokenMs =
      seg.durationMs > NARRATION_TAIL_PAD_MS ? seg.durationMs - NARRATION_TAIL_PAD_MS : seg.durationMs;
    if (spokenMs <= 0) continue; // degenerate window — nothing displayable
    const totalWeight = lines.reduce((acc, l) => acc + l.length, 0);

    // Proportional allocation: intermediate boundaries use Math.round, which could
    // in theory collapse to a zero-length segment in sub-millisecond-per-line windows.
    // In practice the upstream minSceneMs floor (2 000 ms in computeNarrationTimeline)
    // prevents this; the render-handler try/catch contains any edge-case throws otherwise.
    let cumWeight = 0;
    let prevEnd = seg.startMs;
    lines.forEach((line, i) => {
      cumWeight += line.length;
      const isLast = i === lines.length - 1;
      const endMs = isLast
        ? seg.startMs + spokenMs
        : seg.startMs + Math.round((spokenMs * cumWeight) / totalWeight);
      out.push({ sceneId: seg.sceneId, text: line, startMs: prevEnd, endMs });
      prevEnd = endMs;
    });
  }

  return out;
}
