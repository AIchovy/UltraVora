# Voiceover Tab Audio Preview — Design

**Date:** 2026-06-10
**Status:** Approved (pending spec review)

## Problem

The session page's Voiceover tab renders a single line — "narration ready."
([preview-panel.tsx](../../../apps/web/src/components/preview-panel.tsx),
`ArtifactPane` fallback case). Users can't hear the generated narration or
the background music before the final render.

Two gaps:

1. **No UI.** Narration data is fully available (`narration` artifact:
   per-scene `audioFile` in the composition dir, served with Range support
   via `/api/sessions/:sid/files/*`), but nothing renders it.
2. **BGM is untracked.** `generate_music` writes `<random>.wav` into the
   composition dir and returns the bare filename to the agent only. No
   artifact records it, so the frontend cannot reliably locate the BGM file.

## Goal

A multi-track audio preview in the Voiceover tab: one track per narrated
scene plus one track for the background music, playable with seek/volume
controls, themed to match the app. Built on the shadcn registry component
`@audio/block-player-widget`.

## Design

### 1. `music` artifact (shared + server)

- `packages/shared/src/artifact.ts`: add `"music"` to `ARTIFACT_KINDS` and

  ```ts
  export const MusicDataSchema = z.object({
    file: z.string(),          // bare filename in the composition dir
    prompt: z.string(),
    durationSec: z.number().nonnegative(),
  });
  ```

  registered in `ARTIFACT_DATA_SCHEMAS` — same file-pointer pattern as
  `narration`/`mp4`.
- `apps/server/src/phases/registry.ts`: compose phase `outputs` becomes
  `["composition", "music"]`. `markStaleDownstream` then flags the BGM
  stale automatically on revise-back past compose.
- `apps/server/src/tools/music-tools.ts`: `makeGenerateMusicTool` gains an
  `artifacts: ArtifactStore` option; after a successful generation it does
  `artifacts.put(sessionId, "music", { file, prompt, durationSec })`.
  Wired in `pi-compose-handler.ts` where the tool is constructed.
- Old sessions without the artifact simply show no BGM track.

### 2. Web — install the player widget

Run `pnpm dlx shadcn@latest add @audio/block-player-widget` in `apps/web`
(components land under `src/components/audio/`). **This is the first
implementation task**: the installed code's real API (how tracks feed into
`AudioPlayer`/`AudioTrackList`) is the source of truth; the user's snippet
is a reference layout.

Theming: the app already uses shadcn tokens (`bg-card`, `muted`,
`primary`, `rounded-2xl`, `shadow-raised`). Adjust the widget's container
classes to match (rounded-2xl cards, `bg-card` surface, `shadow-xs`).
Controls: keep seek bar, time displays, skip back/forward, play, volume.
**Drop shuffle and repeat** — a 2–7 item queue doesn't need them.

### 3. Web — data + pane

- `apps/web/src/lib/audio-tracks.ts`:

  ```ts
  export interface AudioTrack {
    id: string;
    title: string;
    subtitle?: string;
    src: string;   // /api/sessions/:sid/files/composition/<file>
  }
  export function buildAudioTracks(
    sid: string,
    narration: NarrationData | null,
    music: MusicData | null,
  ): AudioTrack[]
  ```

  One track per narration segment that has an `audioFile` (title
  `Scene <sceneId>`, subtitle `m:ss – m:ss` from startMs/durationMs;
  silent scenes skipped), then one BGM track (title `Background music`,
  subtitle = generation prompt). Pure function, unit-tested.
- `apps/web/src/components/voiceover-pane.tsx`: queries the `narration`
  and `music` artifacts in parallel (each may be missing — a 404 on one
  must not break the other), builds tracks, renders the player. Empty
  state when zero tracks. Shows the stale treatment consistent with other
  panes.
- `preview-panel.tsx`: `narration` case renders `VoiceoverPane`; tab
  visibility for the Voiceover stage becomes "narration OR music artifact
  exists" so BGM-only sessions (voiceover off, bgm on) still get the tab.

### 4. Testing

- shared: `MusicDataSchema` parse test, `music` in kinds.
- server: `generate-music-tool.test.ts` asserts the artifact is written
  with the returned filename; registry test asserts compose outputs.
- web: `buildAudioTracks` unit tests — segment ordering, silent-scene
  skipping, narration-only, music-only, URL shape.

## Error handling

| Case | Behavior |
|---|---|
| `music` artifact missing (old session / bgm off) | no BGM track |
| `narration` missing (voiceover off) | BGM-only track list |
| both missing | tab hidden (unchanged for narration; new check covers music) |
| artifact fetch 404 on one kind | other kind still renders |
| stale artifacts | stale badge as in other panes |

## Out of scope

- Timeline mixing / simultaneous multi-track playback aligned to startMs
  (DAW-style preview) — playlist playback only.
- Regenerating audio from this pane.

## Risk

The `@audio` shadcn registry namespace is third-party. If the install
fails or its API diverges badly from the reference snippet, fall back to a
small in-repo player with the same visual goals; `buildAudioTracks` and
`VoiceoverPane`'s data flow are unaffected.
