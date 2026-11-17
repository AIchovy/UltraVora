# Voice picker (音色选择) — Design

Date: 2026-06-25

## Summary

Let users pick the TTS voice (音色) for their video's voiceover, audition every
voice before choosing, and have that choice drive the actual Gemini TTS call.

Today the voiceover backend already accepts a per-call `voice`
(`TTSInput.voice`, honored at `apps/server/src/providers/gemini-tts.ts:102`),
but the voiceover phase never passes one, so every video uses the hardcoded
default `"Kore"`. And `ConstraintsSchema` has no `voice` field. This feature
adds the field, carries it from the settings UI through the brief to the
voiceover phase, and adds an in-settings voice picker with audio preview.

## Goals

- A voice picker in the video settings dialog: pick one of the 30 prebuilt
  Gemini voices, each labelled with two descriptive tags.
- Audition (试听) any voice inline before choosing, with near-zero latency and
  no per-click cost.
- The chosen voice is passed to Gemini TTS when the voiceover is synthesized.
- The choice persists across refreshes (it is a composer preference).

## Non-goals (YAGNI)

- No per-scene voice. One global voice per video.
- No voice picker on the inline `Composer` in `session-page.tsx` — it is
  rendered with `requireConstraints=false`, so it never sends constraints
  today. Constraints (and thus voice) come only from `HomeComposer` →
  `ComposerSettingsDialog`.
- No live/on-demand preview endpoint. Previews are pre-generated static clips.
- No multi-speaker / dialogue voices.
- The default voice stays `"Kore"`.

## Architecture / data flow

```
ComposerSettingsDialog (voice picker, audition)
        │  voice
        ▼
HomeComposer  ──(constraints.voice in POST /messages)──▶  Brief.constraints.voice
        ▲                                                          │
        │ usePersistentState("uc.voice")                           ▼
   localStorage                                   VoiceoverPhaseHandler reads
                                                  brief.constraints.voice and
                                                  passes it to provider.synthesize({ voice })
                                                          │
                                                          ▼
                                                  GeminiTTSProvider (already honors input.voice)
```

Preview audio is independent of the pipeline: the picker plays a pre-generated
sample clip per voice straight from a public GCS bucket.

## Components

### 1. Voice catalog — `packages/shared/src/voices.ts` (new)

Single source of truth for the voice list, shared by the schema (validation),
the UI (labels + tags), and the sample-generation script (which voices to
synthesize).

```ts
export interface VoiceMeta {
  name: string;            // exact Gemini prebuilt voice name, e.g. "Achernar"
  tags: readonly [string, string]; // [descriptor, pitch]
}

export const VOICES: readonly VoiceMeta[] = [ /* 30 entries, see table below */ ];
export const ALLOWED_VOICES = VOICES.map((v) => v.name) as ...; // readonly tuple of names
export const VoiceSchema = z.enum(ALLOWED_VOICES);
export const DEFAULT_VOICE = "Kore" as const;
export type Voice = z.infer<typeof VoiceSchema>;
```

Re-export from `packages/shared/src/index.ts`.

The 30 voices and tags:

| Voice | Tag 1 | Tag 2 |
|-------|-------|-------|
| Achernar | Soft | Higher pitch |
| Achird | Friendly | Lower middle pitch |
| Algenib | Gravely | Lower pitch |
| Algieba | Smooth | Lower pitch |
| Alnilam | Firm | Lower middle pitch |
| Aoede | Breezy | Middle pitch |
| Autonoe | Bright | Middle pitch |
| Callirrhoe | Easy-going | Middle pitch |
| Charon | Informative | Lower pitch |
| Despina | Smooth | Middle pitch |
| Enceladus | Breathy | Lower pitch |
| Erinome | Clear | Middle pitch |
| Fenrir | Excitable | Lower middle pitch |
| Gacrux | Mature | Middle pitch |
| Iapetus | Clear | Lower middle pitch |
| Kore | Firm | Middle pitch |
| Laomedeia | Upbeat | Higher pitch |
| Leda | Youthful | Higher pitch |
| Orus | Firm | Lower middle pitch |
| Puck | Upbeat | Middle pitch |
| Pulcherrima | Forward | Middle pitch |
| Rasalgethi | Informative | Middle pitch |
| Sadachbia | Lively | Lower pitch |
| Sadaltager | Knowledgeable | Middle pitch |
| Schedar | Even | Lower middle pitch |
| Sulafat | Warm | Middle pitch |
| Umbriel | Easy-going | Lower pitch |
| Vindemiatrix | Gentle | Middle pitch |
| Zephyr | Bright | Higher pitch |
| Zubenelgenubi | Casual | Lower middle pitch |

### 2. Constraints schema — `packages/shared/src/constraints.ts`

Add an optional `voice`:

```ts
export const ConstraintsSchema = z.object({
  // ...existing...
  /** Gemini prebuilt voice for the narration. Absent → backend default (Kore). */
  voice: VoiceSchema.optional(),
});
```

Optional keeps existing messages/briefs valid. Both the UI (always sends a
concrete voice, default `Kore`) and the backend (falls back to provider default
when absent) treat "absent" as `Kore`.

### 3. Backend — `apps/server/src/phases/voiceover-handler.ts`

Read the brief's constraints (same pattern as `render-handler.ts:90` and
`pi-script-handler.ts:36`) and pass the voice to every `synthesize` call:

```ts
const briefEnv = await ctx.artifacts.get<Brief>(ctx.sessionId, "brief");
const voice = briefEnv?.data.constraints.voice; // undefined → provider default
// ...
result = await provider.synthesize({
  text: scene.narration!.trim(),
  outputPath,
  voice,            // ← new
  signal: ctx.signal,
});
```

`gemini-tts.ts` is unchanged: `input.voice ?? this.defaultVoice` already does
the right thing, and `defaultVoice` is `"Kore"`.

### 4. Sample-generation script — `apps/server/scripts/generate-voice-samples.ts` (new)

A one-time, manually-run script (not in CI). For each voice in `VOICES`:

1. Synthesize a fixed sample line with `GeminiTTSProvider` to a local temp WAV.
2. Upload it to the **public** bucket `YOUR_PUBLIC_BUCKET` at key
   `voices/<Name>.wav` via `GcsStorageGateway.upload(localPath, key)`.

- Sample line (one shared line so voices are comparable, ~2–3s), e.g.:
  *"Bright mornings, better coffee. Discover what your product can be."*
- Format: WAV (24 kHz mono 16-bit, exactly what `GeminiTTSProvider` writes).
  ~30 files, a few MB total. No transcoding / ffmpeg dependency.
- Auth: `GEMINI_API_KEY` for TTS; GCP credentials
  (`GOOGLE_APPLICATION_CREDENTIALS`) for an account with **write** access to
  `YOUR_PUBLIC_BUCKET`. The bucket already grants public read (created public
  by the owner), so uploaded objects are publicly readable with no per-object
  ACL step.
- Run via a `package.json` script (e.g. `pnpm -F @ultracreator/server voices:gen`)
  using `tsx`. The target bucket name is a script constant/arg defaulting to
  `YOUR_PUBLIC_BUCKET` (NOT the private `GCS_BUCKET=YOUR_PRIVATE_BUCKET`).
- Idempotent: re-running overwrites the objects. Re-run when the voice list
  changes.

### 5. Frontend — preview URL

Browser plays the sample directly from the public bucket:

```
https://storage.googleapis.com/YOUR_PUBLIC_BUCKET/voices/<Name>.wav
```

Base is configurable via `NEXT_PUBLIC_VOICE_SAMPLE_BASE_URL`
(default `https://storage.googleapis.com/YOUR_PUBLIC_BUCKET/voices`), so it
can later point at a CDN domain. A small helper builds
`` `${base}/${voice.name}.wav` ``. Cross-origin `<audio src>` playback needs no
CORS (media elements load cross-origin without it). Works in dev/CI with zero
GCS config because the URL is public.

### 6. Frontend — state wiring

`apps/web/src/components/home-composer.tsx`:

- `const [voice, setVoice] = usePersistentState<Voice>("uc.voice", DEFAULT_VOICE)`.
- Pass `voice` + `onVoiceChange={setVoice}` to `ComposerSettingsDialog`.
- Include `voice` in the `constraints` object posted in `handleGenerate`.

### 7. Frontend — `apps/web/src/components/composer-settings-dialog.tsx`

- Add props `voice: Voice` and `onVoiceChange: (v: Voice) => void`.
- In the existing `Audio` `Section`, when `voiceover` is on, **reveal** a Voice
  sub-panel directly under the Voiceover row (conditional render so the dialog
  stays compact when voiceover is off):
  - A limited-height (`max-h`, internal `overflow-y-auto`) `role="radiogroup"`
    `aria-label="voice"` containing 30 rows.
  - Each row contains TWO sibling interactive elements (never nested):
    1. a selection control (`role="radio"` / `aria-checked`, or a visually
       hidden native radio + label) whose accessible name is the voice name —
       shows the voice name + two small tag chips;
    2. a separate play button, `aria-label="preview <Name>"`, that toggles
       audition.
  - Selected row uses the existing selected affordance (`bg-card shadow-raised`),
    matching the duration/aspect chips.
  - One shared `HTMLAudioElement`. Clicking a play button loads
    `${base}/<Name>.wav` and plays; clicking again, picking another voice, or
    pressing another play stops the previous clip. A row shows a playing state
    (e.g. ▶ → ◼/pause icon) while its clip plays; reset on `ended`.
- The "Voiceover" row helper may show the current voice name for at-a-glance
  context (optional, low priority).

The `Composer` props/state flow is otherwise unchanged.

## Error handling

- Preview fetch failure (offline, sample missing, bucket hiccup): the audio
  element's `error`/play rejection is caught and ignored (no toast spam); the
  play button simply resets to its idle state. Selection still works without a
  preview.
- Unknown voice value from an old `localStorage` entry: `usePersistentState`
  read is validated against `ALLOWED_VOICES`; fall back to `DEFAULT_VOICE` if it
  is not a known voice (defensive — the set only ever shrinks/changes across
  deploys).
- Backend: an absent/invalid `voice` is impossible past zod validation at
  message ingestion; if somehow absent, the provider default (`Kore`) is used.

## Testing

- `packages/shared` (vitest):
  - `voices`: `VOICES.length === 30`; includes `Kore`; each entry has a name and
    exactly two non-empty tags; `ALLOWED_VOICES` matches names; `DEFAULT_VOICE`
    is in `ALLOWED_VOICES`.
  - `constraints`: `ConstraintsSchema` parses a payload with a valid `voice`,
    rejects an unknown `voice`, and accepts a payload with no `voice`.
- `apps/web` (vitest + jsdom):
  - `ComposerSettingsDialog`: voice radiogroup is absent when `voiceover` is
    off, present when on; clicking a voice row calls `onVoiceChange` with that
    name; the selected row is marked checked; clicking a row's play button
    triggers playback (stub `HTMLMediaElement.play`, which jsdom does not
    implement, to a resolved promise and assert it was called with the right
    `src`).
  - `HomeComposer`: the `constraints` posted in `handleGenerate` include
    `voice` (assert via the mocked `postMessage`).
- `apps/server` (vitest):
  - `voiceover-handler`: extend the existing test so the fake TTS provider
    captures the `voice` argument; assert it equals `brief.constraints.voice`
    when set, and is `undefined` (→ provider default) when the brief omits it.
  - `gemini-tts`: existing test already covers `input.voice` pass-through; no
    change needed.
- The sample-generation script is not unit-tested (needs a real API key + GCP
  creds); it is excluded from CI.

## File-by-file change list

New:
- `packages/shared/src/voices.ts`
- `apps/server/scripts/generate-voice-samples.ts`
- tests: `packages/shared/test/voices.test.ts` (or co-located), web + server test
  additions.

Modified:
- `packages/shared/src/constraints.ts` (add `voice`)
- `packages/shared/src/index.ts` (export voices)
- `apps/server/src/phases/voiceover-handler.ts` (read brief, pass voice)
- `apps/server/package.json` (add `voices:gen` script)
- `apps/web/src/components/composer-settings-dialog.tsx` (voice picker)
- `apps/web/src/components/home-composer.tsx` (persist + send voice)
- `apps/web/.env.local.example` (document `NEXT_PUBLIC_VOICE_SAMPLE_BASE_URL`)
- existing tests touching constraints/handler/dialog as needed.

## Open assumptions

- `YOUR_PUBLIC_BUCKET` exists and grants public read; the script's GCP
  credentials have write access to it.
- The 30 voice names are valid for the configured Gemini TTS model
  (`gemini-2.5-flash-preview-tts`). The sample-generation run is the practical
  validation; any voice that errors during generation is surfaced by the script.
