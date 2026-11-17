import type { MusicData, NarrationData } from "@ultracreator/shared";
import type { Track } from "@/lib/html-audio";
import { fileUrl } from "@/lib/api-client";

function fmt(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Map the narration + music artifacts onto player tracks, narration first.
 *
 * Narration re-runs overwrite the SAME narration-<sceneId>.wav files, so the
 * URL alone never changes — pass the narration artifact's version to append a
 * `?v=` cache-buster or the browser keeps playing its cached old take. (BGM
 * files get a fresh random name per generation, so they don't need one; the
 * files route ignores query strings.)
 */
export function buildAudioTracks(
  sid: string,
  narration: NarrationData | null,
  music: MusicData | null,
  narrationVersion?: number,
): Track[] {
  const tracks: Track[] = [];
  const buster = narrationVersion !== undefined ? `?v=${narrationVersion}` : "";
  for (const seg of narration?.segments ?? []) {
    if (!seg.audioFile) continue; // silent scene
    tracks.push({
      id: `narration-${seg.sceneId}`,
      url: `${fileUrl(sid, `composition/${seg.audioFile}`)}${buster}`,
      title: `Scene ${seg.sceneId}`,
      artist: `Voiceover · ${fmt(seg.startMs)} – ${fmt(seg.startMs + seg.durationMs)}`,
      duration: seg.durationMs / 1000,
    });
  }
  if (music) {
    tracks.push({
      id: "bgm",
      url: fileUrl(sid, `composition/${music.file}`),
      title: "Background music",
      artist: music.prompt,
      duration: music.durationSec,
    });
  }
  return tracks;
}
