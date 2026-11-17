# Narration Audio-Driven Retiming Design

**Date:** 2026-06-03
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Make the rendered video's timing align with the TTS narration: synthesize narration
per scene, measure each clip's real duration, and recompute the scene timeline from
those durations so each scene's visuals play while its own narration is heard — with
no trailing silence or cut-off audio.

## Background / Problem

The pipeline order is research → design → script → voiceover → compose → render.
Today narration is misaligned in two ways:

1. **One undifferentiated blob.** `voiceover-handler.ts` joins every
   `scene.narration` with `\n\n`, makes ONE TTS call, writes ONE `narration.wav`,
   and compose adds ONE `<audio data-start="0">`. Scene 2's narration can play while
   scene 1 is still on screen — no per-scene correspondence.
2. **Two independent clocks.** `script` defines the visual timeline (`totalSec`,
   per-scene `startSec`/`durationSec`); the TTS audio length is whatever Gemini
   returns. They never reconcile → audio shorter than video = trailing silence;
   longer = cut off.

Root cause: the visual clock (script's plan) and the voice clock (actual TTS) are
independent and nobody aligns them.

## Strategy (decided)

**Audio-driven retiming.** The narration is the master clock. Per-scene synthesis →
measure each scene's audio duration → recompute the scene timeline so narrated
scenes last as long as their audio (plus a small tail) and silent scenes keep their
planned duration. Visuals bend to the voice (how real explainer videos are paced).

## Architecture decision: the narration artifact owns the final timeline

The `narration` artifact is upgraded to hold the authoritative, retimed timeline for
**all** scenes. The `script` artifact is **not** mutated — it remains "content +
intended pacing" (UI, lineage, and refinement are unaffected).

- `script` = intent (unchanged).
- `narration` = the final timeline when voiceover ran (audio-driven), covering every
  scene (narrated → audio-derived; silent → planned), plus the per-scene audio file.
- `compose` = if a `narration` artifact exists, use its timeline; otherwise fall back
  to the `script` timeline (fully backward compatible — `withVoiceover=false` or a
  narrationless script behaves exactly as today).

Rejected alternative: rewriting `script`'s scene durations. That makes script both
intent and result, changes the timings shown in the UI, and muddies version
semantics. Not chosen.

## Components

### `NarrationDataSchema` (packages/shared/src/artifact.ts) — upgraded

Replace the current `{ audioPath, durationMs, wordTimings? }` shape with a per-scene
timeline:

```
NarrationData = {
  totalMs: number,                       // sum of all scene durations, ms
  segments: Array<{
    sceneId: string,                     // matches script Scene.id
    audioFile?: string,                  // bare filename in composition dir, e.g. "narration-s1.wav"; absent for silent scenes
    startMs: number,                     // absolute start on the master timeline
    durationMs: number,                  // scene duration on the master timeline
  }>,
}
```

`segments` is ordered and covers EVERY scene in the script (narrated and silent), so
compose can read the full timeline from one place. `audioFile` is present only for
scenes that had narration. `wordTimings` is dropped (it was unused; captions are out
of scope).

### `narration-timeline.ts` (new, pure) — the retiming function

A pure, deterministic, unit-testable function:

```
computeNarrationTimeline(
  scenes: Array<{ id: string; durationSec: number }>,   // from script, in order
  audioDurationMsBySceneId: Record<string, number>,     // only narrated scenes appear
  opts?: { tailPadMs?: number; minSceneMs?: number },
): NarrationData
```

Rules (defaults, tunable via opts):
- **Narrated scene** (`sceneId` present in `audioDurationMsBySceneId`):
  `durationMs = max(audioDurationMs + tailPadMs, minSceneMs)`.
- **Silent scene**: `durationMs = round(scene.durationSec * 1000)` (planned).
- `startMs` = running cumulative sum in scene order; `segments` preserves order.
- `totalMs` = sum of all `durationMs`.
- Defaults: `tailPadMs = 500`, `minSceneMs = 2000`.
- `audioFile` set to `narration-<sceneId>.wav` for narrated scenes, omitted otherwise.

### `voiceover-handler.ts` — per-scene synthesis + retiming

- Read `script`. Collect scenes with non-empty `narration`.
- If none → no-op (emit "no narration; skipping TTS", write no artifact) — unchanged
  behavior.
- For each narrated scene, call `provider.synthesize({ text: scene.narration,
  outputPath: composition/narration-<sceneId>.wav, signal })`; collect its
  `durationMs` into `audioDurationMsBySceneId`. (Sequential; honor `ctx.signal`
  between scenes.)
- Call `computeNarrationTimeline(script.scenes, audioDurationMsBySceneId)` → write the
  `narration` artifact (derivedFrom script).

### `pi-compose-handler.ts` — consume the timeline

- If a `narration` artifact exists:
  - Copy each `segment.audioFile` into the composition dir (they're already written
    there by voiceover, but keep the existing defensive copy/traversal-guard pattern).
  - Set the root `data-duration` from `narration.totalMs` (converted to seconds).
  - Inject the per-scene timeline into the prompt: for each scene, its exact
    `data-start`/`data-duration` (from segments) and, for narrated scenes, the audio
    filename. Instruct the agent to (a) use these EXACT timings for each scene clip
    and (b) add one `<audio data-track-index="0" data-start=<segStart> data-duration=<segDur>>`
    per narrated scene.
- If no `narration` artifact: behave exactly as today (script-derived timing, no
  audio) — backward compatible.

Note: the retiming math lives in code (`computeNarrationTimeline`), not in the agent.
The agent only transcribes the precise numbers it is given. This keeps alignment
deterministic.

**Units:** `NarrationData` is in milliseconds. hyperframes `data-start` /
`data-duration` are in **seconds**. compose converts ms→seconds when building the
prompt for every value it injects (root `data-duration`, each scene's
`data-start`/`data-duration`, and each audio clip's `data-start`/`data-duration`).
Convert once at the compose boundary; keep the artifact in ms.

## Data Flow

```
script (scenes[].narration, planned durations)
  → voiceover:
      per narrated scene → Gemini TTS → narration-<sceneId>.wav (+ measured durationMs)
      computeNarrationTimeline(scenes, durations) → narration artifact { totalMs, segments[] }
  → compose:
      narration present? → use segments for scene data-start/data-duration + root data-duration,
                           add one <audio track 0> per narrated scene
                         : fall back to script timeline (no audio)
  → render: hyperframes plays each per-scene audio clip in sync, muxes to mp4
```

## Error / edge handling

- **No narrated scenes:** voiceover no-op, no `narration` artifact, compose uses
  script timeline (today's behavior).
- **A single scene's TTS fails:** surface as a phase error (consistent with the
  current eager-provider behavior). Do not silently drop a scene's audio and leave the
  timeline claiming it exists. (The synthesize call already throws on failure.)
- **Silent scenes interleaved with narrated ones:** handled — they keep planned
  duration and have no `audioFile`.
- **Abort:** check `ctx.signal` between per-scene synth calls.
- **hyperframes same-track rule:** all audio clips are on `data-track-index="0"` and,
  because each scene's audio sits within its own non-overlapping scene window, they
  never overlap.

## File Structure Summary

- Modify: `packages/shared/src/artifact.ts` (`NarrationDataSchema`)
- Create: `apps/server/src/phases/narration-timeline.ts` (pure `computeNarrationTimeline`)
- Modify: `apps/server/src/phases/voiceover-handler.ts` (per-scene synth + retiming)
- Modify: `apps/server/src/phases/pi-compose-handler.ts` (consume per-scene timeline)
- Tests: `apps/server/test/narration-timeline.test.ts` (new),
  `apps/server/test/voiceover-handler.test.ts` (update/extend),
  `apps/server/test/pi-compose-handler.test.ts` (extend)

## Testing

- **`narration-timeline.ts`** (pure): mixed narrated/silent scenes; tail-pad and
  min-floor applied to narrated; planned duration kept for silent; cumulative
  `startMs` correct; `totalMs` = sum; `audioFile` set only for narrated scenes.
- **voiceover-handler**: stub TTS returns fixed per-call durations; assert one
  synth call per narrated scene with the right text/output path, and the written
  `narration` artifact's `segments`/`totalMs` match the timeline; narrationless
  script → no artifact.
- **compose-handler**: faux model; with a `narration` artifact present, assert the
  prompt carries per-scene timings and the authored HTML has one `<audio
  data-track-index="0">` per narrated scene at the segment start; with no narration,
  the script-timeline fallback path still authors and persists the composition
  (existing tests stay green).
- Run `vitest` from repo root; `npm run typecheck` clean.

## Out of scope

- Captions / subtitles from word timings (the `wordTimings` field is removed).
- TTS speed/rate control or switching providers (still Gemini, voice "Kore").
- Per-scene voices or SSML.
- Music/background audio.
```
