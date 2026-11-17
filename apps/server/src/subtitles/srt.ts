import type { SubtitleSegment } from "@ultracreator/shared";

function fmt(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}

/** Serialize caption segments to a standard SRT document. */
export function segmentsToSrt(segments: SubtitleSegment[]): string {
  return segments
    .map((seg, i) => `${i + 1}\n${fmt(seg.startMs)} --> ${fmt(seg.endMs)}\n${seg.text}\n`)
    .join("\n");
}
