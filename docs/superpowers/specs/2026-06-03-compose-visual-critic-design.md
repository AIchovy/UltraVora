# Compose Visual-Critic Loop Design

**Date:** 2026-06-03
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Give the compose phase "eyes": after the deterministic structural checks pass,
render per-scene hero-frame screenshots, have a vision model judge them for a small
set of OBJECTIVE defects, and re-author the composition when a scene is broken
(covered by a solid overlay, blank/black, or with obscured/unreadable text) — before
the expensive render step.

## Background / Problem

The compose quality loop runs only deterministic CLI checks: `lint` (structure),
`validate` (WCAG contrast), `inspect` (layout overflow). None can detect a scene that
renders as a solid color, a blank/black beat, or content hidden behind an overlay.
Three real failures slipped through:

- Empty styled card grid → three black boxes (session d72fa2e1).
- A full-screen "wipe" overlay that grows to cover each scene and never retracts →
  scenes 2–5 render as solid purple/yellow/green/blue (session b85a8365).
- General "looks generic / too dark / too sparse" reports.

All are visual-correctness issues a deterministic checker structurally cannot see.
This loop closes that gap for the OBJECTIVE, catastrophic subset.

## Key decisions (from brainstorming)

1. **Block only on objective hard defects.** The critic fails (triggers a re-author)
   ONLY for: a scene `covered` (solid color / overlay hiding content), `blank`
   (empty / black / not-loaded), or `text_obscured` (text hidden or unreadable
   because it's covered). Subjective "looks mediocre / off-brand / cluttered" is NOT
   judged here — that would churn the loop chasing taste.
2. **Structure first, then a separate visual pass with its own small budget.** Run
   the existing `lint/validate/inspect` loop to convergence first (cheap,
   deterministic). THEN run the visual pass (capture + vision), with its own round
   budget (default 2). Vision is not re-run on every structural fix round.
3. **Degrade, never block the pipeline.** If no vision model is configured
   (no `GEMINI_API_KEY` / no critic injected), skip the visual pass entirely (log
   it). If the visual budget is exhausted with unresolved hard defects, emit a
   warning and PROCEED to persist the composition — do NOT fail the whole pipeline.
   Rationale: a vision model can false-positive; it must not be able to take down all
   video generation. The deterministic checks remain the hard gates.

## Reuse (already in the codebase)

- `hyperframes snapshot <dir> --at <t1,t2,…>` captures per-timestamp PNG hero frames
  (headless Chrome, seeks the GSAP timeline) into `<dir>/snapshots/`. We invoke it
  with `--describe false` (capture only; we run our own structured critique). Same
  `npx --package=hyperframes` mechanism the quality runner already uses.
- `@google/genai` is already a dependency (the Gemini TTS provider uses it). The
  visual critic reuses that SDK and the provider-with-stub pattern.

## Architecture

Compose phase, after the structural loop converges:

```
compute hero timestamps (one per scene)
  → SnapshotRunner.capture(compositionDir, timestamps)  → frame PNG paths
  → VisualCritic.critique(frames, scenes)               → { ok, issues[] }
  → if !ok and rounds remain: re-author with the issues → re-capture → re-critique
  → persist composition (always, after budget; warn if still !ok)
```

Two injectable collaborators (parallel to the existing `qualityRunner` option), each
with a real impl + a stub:

- **`SnapshotRunner`** — captures frames via the CLI.
- **`VisualCritic`** — turns frames into a structured verdict via the vision model.

The compose handler only runs the visual pass when a `visualCritic` is provided;
otherwise it skips (degradation path).

## Components

### `computeHeroTimestamps` (pure) — `apps/server/src/phases/hero-timestamps.ts`

```
computeHeroTimestamps(
  scenes: Array<{ id: string; startSec: number; durationSec: number }>,
  opts?: { fraction?: number },   // default 0.6
): Array<{ sceneId: string; atSec: number }>
```
`atSec = startSec + durationSec * fraction` (content fully entered, not yet exiting).
When a `narration` artifact exists, the caller derives `startSec`/`durationSec` from
its per-scene timeline (ms→seconds); otherwise from `script.scenes`. Pure,
unit-testable.

### `SnapshotRunner` — `apps/server/src/render/snapshot-runner.ts`

```
interface SnapshotRunner {
  capture(projectDir: string, atSec: number[], signal: AbortSignal): Promise<string[]>; // frame paths, in order
}
class HyperframesSnapshotRunner implements SnapshotRunner {
  constructor(opts?: { commandFor?: (dir, atSec) => string[]; timeoutMs?: number });
}
```
Default command: `["npx","--package=hyperframes","hyperframes","snapshot", dir, "--at", atSec.join(","), "--describe","false"]`.
Returns the paths under `<dir>/snapshots/` (ordered to match `atSec`). `commandFor`
is injectable for tests (mirrors `HyperframesQualityRunner`). Capture failure is
non-fatal: it returns `[]` and the visual pass is skipped for that round (logged).

### `VisualCritic` — `apps/server/src/render/visual-critic.ts`

```
type VisualDefect = "covered" | "blank" | "text_obscured";
interface VisualIssue { sceneId: string; defect: VisualDefect; note: string }
interface VisualVerdict { ok: boolean; issues: VisualIssue[] }

interface VisualCritic {
  critique(input: {
    frames: Array<{ sceneId: string; path: string }>;
    scenes: Array<{ id: string; onScreenText?: string; visual: string }>;
    signal: AbortSignal;
  }): Promise<VisualVerdict>;
}
```

- **`GeminiVisualCritic`** (real): scales each PNG (sharp, like `hyperframes snapshot`)
  to stay under Gemini's inline limit, sends the frames + a strict rubric prompt to
  `gemini-3.1-flash-lite-preview` (overridable), and uses structured output to return
  per-scene verdicts. The rubric instructs: flag ONLY `covered`/`blank`/`text_obscured`;
  if a frame shows real, legible content, return `ok` for that scene; do NOT comment
  on aesthetics/taste. `ok = issues.length === 0`. Constructed with an API key like
  `GeminiTTSProvider`; bootstrap wires it only when `GEMINI_API_KEY` is set.
- **`StubVisualCritic`** (tests): returns a caller-supplied canned `VisualVerdict`.

### Compose handler wiring — `apps/server/src/phases/pi-compose-handler.ts`

- New optional option `visualCritic?: VisualCritic` and `snapshotRunner?: SnapshotRunner`
  (default `HyperframesSnapshotRunner`), plus `maxVisualRounds?` (default 2).
- After the structural loop breaks `ok`:
  - If `visualCritic` is undefined → skip (yield a progress note), persist as today.
  - Else loop up to `maxVisualRounds`: compute hero timestamps → `capture` → if no
    frames, break (logged) → `critique`. If `ok`, break. Else, if rounds remain,
    yield a progress event and re-author via `runAgentToCompletion` with a prompt
    listing the issues (e.g. `scene <id>: <defect> — <note>. Fix so the scene's
    content is fully visible; any covering overlay must animate back to scale/opacity
    0.`). After the budget, if still `!ok`, yield a `phase.progress` warning (NOT
    `phase.error`).
  - Persist the composition artifact (unchanged path).

## Data Flow

```
structural loop ok
  → computeHeroTimestamps(scenes from narration timeline or script)
  → HyperframesSnapshotRunner.capture → <dir>/snapshots/frame-*.png
  → GeminiVisualCritic.critique(frames, scenes) → { ok, issues }
  → ok? persist : (rounds left? re-author with issues → recapture/recritique : warn + persist)
```

## Error / edge handling

- **No API key / no critic injected:** skip the visual pass, persist normally.
- **Capture returns no frames** (snapshot failed/timeout): skip the visual pass for
  that run, log it, persist. Never fatal.
- **Critic throws / vision API error:** treat as skip-with-warning for that round
  (catch, log); do not fail the phase. (A vision outage must not block rendering.)
- **Abort:** check `ctx.signal` before capture and between visual rounds.
- **Budget exhausted, still defective:** warn and persist (decision 3).

## File Structure Summary

- Create: `apps/server/src/phases/hero-timestamps.ts` (pure)
- Create: `apps/server/src/render/snapshot-runner.ts` (`SnapshotRunner` + Hyperframes impl)
- Create: `apps/server/src/render/visual-critic.ts` (`VisualCritic` + `GeminiVisualCritic` + `StubVisualCritic`)
- Modify: `apps/server/src/phases/pi-compose-handler.ts` (visual pass after structural loop)
- Modify: bootstrap wiring (where `PiComposePhaseHandler` is constructed) to inject a
  `GeminiVisualCritic` when `GEMINI_API_KEY` is set
- Tests: `hero-timestamps.test.ts`, `snapshot-runner.test.ts`, `visual-critic.test.ts`,
  extend `pi-compose-handler.test.ts`

## Testing

- **`computeHeroTimestamps`** (pure): exact `atSec` per scene with default and custom
  fraction; multiple scenes; respects supplied start/duration.
- **`SnapshotRunner`**: inject `commandFor` stub (like quality-runner) — assert it
  invokes `hyperframes snapshot <dir> --at <joined> --describe false`; on non-zero
  exit returns `[]` (non-fatal).
- **`GeminiVisualCritic`**: inject a fake `GoogleGenAI`-shaped client (like the
  gemini-tts test) returning a structured verdict; assert parsing into
  `VisualVerdict`, `ok` derivation, and that a clean-frames response yields `ok:true`.
- **compose-handler**: with a `StubVisualCritic` —
  (a) verdict `ok:true` → no re-author, composition persisted;
  (b) verdict with a `covered` issue then `ok` on retry → re-authored once, persisted,
      progress events show the visual round;
  (c) persistent defect → after `maxVisualRounds`, a warning event is emitted and the
      composition is STILL persisted (no `phase.error`);
  (d) no `visualCritic` injected → visual pass skipped, existing behavior unchanged.
- Run `vitest` from repo root; `npm run typecheck` clean.

## Out of scope

- Subjective/aesthetic critique (taste, brand-fit, clutter) as a blocking gate.
- Re-running the structural loop after a visual re-author (the visual re-author still
  produces valid HTML; a follow-up structural recheck is not run in v1 — YAGNI; can
  revisit if visual fixes ever reintroduce structural errors).
- A separate post-render frame check (this operates on the composition pre-render).
- Caching/dedup of vision calls across sessions.
