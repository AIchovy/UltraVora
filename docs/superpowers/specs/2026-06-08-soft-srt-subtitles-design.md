# Soft SRT Subtitles (replace burned-in hard subtitles)

Date: 2026-06-08
Status: Approved (design)

## Problem

When `constraints.subtitles` is enabled, the compose-phase LLM writes
`<span class="sub-clip">` lines plus GSAP show/hide timing into the composition
`index.html`. The HyperFrames renderer then bakes those subtitles into the mp4
pixels (hard subtitles). Two problems:

1. Hard subtitles cannot be turned off by the viewer and cannot be edited or
   re-used after render.
2. The web player has no way to toggle captions.

## Goal

- Stop burning subtitles into the video. The rendered mp4 must be clean (no
  on-screen transcript).
- Produce a standard `.srt` subtitle file as a deliverable artifact (downloadable,
  uploadable to YouTube, etc.).
- The web player gets a custom CC on/off toggle and a download-SRT link.

## Decisions (locked)

- **Hard subtitles: fully removed.** No optional burn-in mode. (Trade-off accepted:
  soft captions do not show in muted-autoplay social feeds; out of scope for now.)
- **Timing source: deterministic, code-derived** from the narration timeline. No
  LLM involvement, no extra cost, no per-run variance.
- **Scope: pipeline only.** The existing rendered video `811a3e39-...` is not
  backfilled — its mp4 already has burned-in subtitles and only a re-render would
  remove them.
- **Player: custom CC toggle button** in `video-preview.tsx` (not the native
  `<video controls>` CC button, which is inconsistent across browsers).

## Data Flow

```
script.v1.json     (per-scene narration text — verbatim)
narration.v1.json  (per-scene startMs / durationMs — authoritative timing)
        │
        ▼  buildSubtitles()   ← pure function, deterministic, no LLM
  SubtitleSegment[] { text, startMs, endMs, sceneId }
        │
        ├──► subtitles.v1.json   (new structured artifact)
        └──► output/<mp4-id>.srt  (deliverable file, downloadable)
        │
        ▼  web player
  <video> + runtime SRT→WebVTT blob mounted as <track> + custom CC toggle
```

Subtitles depend only on `script` + `narration`; they are decoupled from
composition/render. The composition no longer contains any subtitle markup, so the
mp4 is clean.

## Components

### a) Shared layer — new artifact kind
File: `packages/shared/src/artifact.ts`

- Add `"subtitles"` to `ARTIFACT_KINDS` (positioned after `composition`, before `mp4`).
- New Zod schemas:
  - `SubtitleSegment = { text: string; startMs: int ≥ 0; endMs: int > startMs; sceneId: string }`
  - `SubtitlesData = { language: "en"; segments: SubtitleSegment[]; srtPath: string }`
- Register `subtitles: SubtitlesDataSchema` in `ARTIFACT_DATA_SCHEMAS`.
- Derivation: `subtitles` derivedFrom `[script, narration]`.

### b) Pure function: `buildSubtitles(scriptScenes, narrationData)`
New server module (TDD focus).

- For each **narrated** scene (skip silent scenes), take the verbatim narration text.
- Split into sentences (`.`, `!`, `?`). If a sentence exceeds ~10 words, sub-split at
  comma/clause boundaries or by word count into ~6–10-word lines.
- Distribute lines across the scene's spoken window
  `[startMs, startMs + spokenMs)` where `spokenMs = durationMs − tailPad`
  (`tailPad` = 500 ms, matching `computeNarrationTimeline`). Allocate each line's
  duration **proportional to its character/word length**.
- Constraints:
  - Minimum display duration per line ~1 s.
  - No overlap: `endMs[n] ≤ startMs[n+1]`.
  - Silent scenes produce no segments.

### c) Pure function: `segmentsToSrt(segments)`
New server module (TDD).

- Standard SRT: index / `HH:MM:SS,mmm --> HH:MM:SS,mmm` / text / blank line.

### d) Pipeline wiring
- A lightweight step (after narration timeline is computed; may live in or adjacent
  to `render-handler.ts`). When `constraints.subtitles === true`:
  1. `buildSubtitles(...)` → write `subtitles.v1.json` artifact.
  2. `segmentsToSrt(...)` → write `output/<mp4-id>.srt` (same basename as the mp4 for
     easy pairing); store `srtPath` (relative) in the artifact data.
- **Remove burn-in:** delete the `SUBTITLES_INSTRUCTION` block and its injection in
  `apps/server/src/phases/pi-compose-handler.ts` (~line 175). Compose no longer emits
  `sub-clip` spans or subtitle GSAP timing.

### e) Web player
Files: `apps/web/src/components/artifact-viewer.tsx`, `video-preview.tsx`,
`apps/web/src/lib/api-types.ts`.

- `artifact-viewer.tsx`: in addition to querying `mp4`, query the `subtitles`
  artifact and pass `srtPath` to `VideoPreview` (optional — older sessions lack it).
- `video-preview.tsx`:
  - `useState` for captions on/off.
  - On enable: `fetch(fileUrl(sid, srtPath))` → convert SRT text to WebVTT →
    `Blob` URL → inject `<track kind="subtitles" default>`; set
    `textTrack.mode = "showing" | "hidden"`.
  - UI: a CC on/off button next to the existing Download button, plus a
    **Download .srt** link.
- Browsers' native `<video>` `<track>` only accepts WebVTT, so SRT→VTT conversion
  happens client-side. Add `SubtitlesData` to `api-types.ts`.

## Testing

- **TDD unit tests:**
  - `buildSubtitles`: sentence splitting, proportional allocation, tail-pad trimming,
    no-overlap invariant, silent-scene skipping, single-line and boundary cases.
  - `segmentsToSrt`: timecode formatting (zero-pad, comma ms), ordering, blank lines.

## Out of scope (YAGNI)

- Word-level / karaoke highlighting.
- Multi-language translation.
- Optional hard-subtitle (burn-in) mode — fully removed.
- Backfilling the existing `811a3e39` video.

## Untouched

TTS, the HyperFrames renderer, and BGM logic are not modified.
