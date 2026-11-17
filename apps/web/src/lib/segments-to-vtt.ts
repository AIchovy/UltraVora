import type { SubtitleSegment } from "@ultracreator/shared";

function fmt(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(millis, 3)}`;
}

/**
 * Build a WebVTT document (the only subtitle format `<track>` accepts) directly
 * from the caption segments carried in the subtitles artifact.
 *
 * We render from `segments` rather than fetching the `.srt` file because once a
 * session's media is archived, the file route 302-redirects to a cross-origin
 * GCS signed URL. A `<video>`/`<img>` follows that redirect fine, but a
 * `fetch()` is blocked without CORS — which silently hid the captions toggle.
 * The segments are already in hand from the artifact JSON, so no second hop.
 */
export function segmentsToVtt(segments: SubtitleSegment[]): string {
  const cues = segments
    .map((seg) => `${fmt(seg.startMs)} --> ${fmt(seg.endMs)}\n${seg.text}`)
    .join("\n\n");
  return cues ? `WEBVTT\n\n${cues}\n` : "WEBVTT\n";
}
