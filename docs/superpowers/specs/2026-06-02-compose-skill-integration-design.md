# Compose-Phase Skill Integration Design

**Date:** 2026-06-02
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Make the COMPOSE phase author materially better videos by actually integrating the
`gsap` and `hyperframes` Claude Code skills, rather than relying on the current
hand-distilled ~60-line system prompt. Plus give the agent "eyes" via the
hyperframes `inspect` layout check in the quality loop, and fix the exit/transition
rules the agent currently violates.

## Background / Why

The compose agent is a server-side Pi LLM agent. Today it receives ONLY a thin,
hand-written `SYSTEM_PROMPT` in `apps/server/src/phases/pi-compose-handler.ts`, a
`write_composition_file` tool, and a quality loop running `hyperframes lint` +
`hyperframes validate`. It never sees the real gsap/hyperframes skill content.

Auditing a real generated composition
(`workspaces/d72fa2e1-.../composition/index.html`) against the skills showed the
agent violated multiple non-negotiable skill rules:

- Used **banned fonts** (Outfit + Roboto — both on the typography banned list).
- Wrote **exit animations on non-final scenes** (`gsap.to(opacity:0)` on scenes
  1/2/3) — skills mandate "the transition IS the exit; no exit animations except
  the final scene".
- **No real transitions** (only opacity fades), **no background/ambient layer**,
  **single centered focal point per scene**, **identical empty card grid** (the
  three black boxes the user reported — "identical card grids" is a listed AI
  design tell, and empty styled containers render as black boxes).
- Pure `#000000` background ("reads as nothing loaded").
- Monotonous easing (`power3.out` everywhere).

The skills diagnose every one of these. The fix is to deliver the skill knowledge
to the agent and to add the layout-feedback check it currently lacks.

## Scope

In scope (all three confirmed):

1. **Knowledge injection** — vendored distilled skill knowledge + a `read_reference`
   tool for on-demand depth.
2. **Visual feedback loop** — add `hyperframes inspect` to the quality runner
   (deterministic CLI only; no vision model in v1).
3. **Exit/transition rule fixes** — correct the non-negotiable rules in the system
   prompt.

Out of scope (v1):

- **`animation-map`** choreography check — it is only a skill script, not a
  hyperframes CLI command, so it is not portable to the server runtime. `inspect`
  covers layout/overflow; choreography quality is addressed at authoring time by
  the injected motion-principles knowledge. May revisit later.
- **Vision-model visual critique** (screenshots → vision model). Deferred; the
  deterministic CLI checks + the "no empty containers" rule cover the reported
  failures for now.

## Constraints

- The gsap/hyperframes skill files live in `~/.claude/skills/`, NOT in the repo,
  and are not guaranteed present at server runtime. Therefore knowledge must be
  **vendored into the repo** (version-controlled, deployable).
- The server runs via `tsx` (reads from `src/`), so runtime reads of vendored
  `.md` files from a `src/` subdirectory work without a build copy step. The plan
  must confirm/handle this for any built/dist path.
- `hyperframes inspect` is a first-class CLI command
  (`packages/cli/src/commands/inspect.ts`), invoked via the same
  `npx --package=hyperframes hyperframes <kind> --json <dir>` mechanism the quality
  runner already uses for lint/validate.

## Architecture

Three changes, all centered on the compose phase:

- **A. Knowledge base (vendored markdown)** in
  `apps/server/src/phases/compose-knowledge/`.
- **B. `read_reference` tool** the compose agent calls on demand.
- **C. `inspect` in the quality runner**, feeding layout diagnostics back into the
  existing fix loop.

## Components

### Knowledge base — `apps/server/src/phases/compose-knowledge/`

Focused, distilled markdown (distilled from the skills I read; NOT verbatim copies):

- `motion.md` — motion-principles distilled (vary eases / vary durations / vary
  entrance direction / build-breathe-resolve / `.out` for entrances, `.in` for
  exits / stagger by importance under 500ms / asymmetry) + gsap essentials
  (timeline position parameter `"<"`, `"<0.2"`, labels; easing system; stagger
  objects; transform aliases; `autoAlpha`; `gsap.defaults`).
- `typography.md` — serif+sans (not two sans), **banned-fonts list**, extreme
  weight contrast (300 vs 900), dark-background weight/line-height compensation,
  tracking, `tabular-nums` for data.
- `layout.md` — Layout-Before-Animation discipline (content containers use
  `width/height:100% + padding + flex`, absolute only for decoratives); visual
  composition (≥2 focal points, ≥3 layers, fill the frame, anchor to edges, split
  frames); mandatory background/ambient layer (2-5 decoratives with slow motion);
  "Lazy defaults to question" anti-patterns (gradient text, accent stripes,
  cyan-on-dark, pure #000/#fff, identical card grids, everything centered).
- `transitions.md` — energy→primary-transition table, the **exit-animations-banned
  rule** (transition is the exit; final scene only may fade out), presets, and 2-3
  concrete CSS transition recipes (e.g. blur crossfade, push slide, staggered
  blocks).
- `effects.md` — typewriter + audio-visualizer drop-in patterns. Included (one
  small file; typewriter in particular is common in promos).

The five topic keys are therefore: `motion`, `typography`, `layout`,
`transitions`, `effects`.

### System prompt changes — `pi-compose-handler.ts`

The system prompt carries the **compact non-negotiable core** (cheap, always on):

- Banned fonts (don't use Inter/Roboto/Outfit/Poppins/Syne/…).
- No empty styled containers (already added; keep).
- Exit animations BANNED except the final scene — the transition is the exit.
- Always use real scene transitions (pick one primary by energy + 1-2 accents).
- Layout-Before-Animation discipline; video sizing (60px+ headlines, 20px+ body);
  background layer required; ≥2 focal points / ≥3 layers per scene.
- Determinism (no Math.random/Date.now/repeat:-1).

It also lists the available `read_reference` topic keys and instructs the agent to
read the relevant ones before authoring.

### `read_reference` tool

- Input: `topic` — an enum of known keys (`motion`, `typography`, `layout`,
  `transitions`, `effects`).
- Behavior: reads the corresponding file from the fixed `compose-knowledge`
  directory and returns its text. No arbitrary paths; reject unknown keys. No path
  traversal possible (key → fixed filename map).
- Lives alongside the other compose tools; registered on the compose agent only.

### Quality runner — `apps/server/src/render/quality-runner.ts`

- Extend the check sequence from `["lint", "validate"]` to
  `["lint", "validate", "inspect"]`.
- `inspect` invoked as `npx --package=hyperframes hyperframes inspect --json <dir>`
  (via the existing `commandFor` hook so tests can stub it).
- A non-zero `inspect` exit contributes its diagnostics to the combined
  `diagnostics` string, which the compose handler already feeds back to the agent
  in the existing `maxRounds` fix loop. No new loop needed.

## Data Flow (one compose run)

1. Handler builds the prompt (existing design/script/assets context + new core
   rules + reference-key listing).
2. Agent optionally calls `read_reference("transitions")` etc., gets depth
   knowledge, authors `index.html` (+ optional css/sub-comps) via
   `write_composition_file`.
3. Quality runner runs `lint → validate → inspect`. Any failure → combined text
   diagnostics fed back to the agent → re-author (existing loop, existing
   `maxRounds`).
4. All pass → persist the `composition` artifact (unchanged).

## Testing

- **`read_reference` tool**: returns the correct file content for each known key;
  rejects an unknown/invalid key. (No faux model needed — direct tool test.)
- **Quality runner**: inject `commandFor` stub; assert `inspect` is invoked after
  lint/validate, and that an `inspect` failure surfaces in `diagnostics` (reuse the
  existing stub pattern in `quality-runner.test.ts`).
- **Compose handler**: faux model that first calls `read_reference` then
  `write_composition_file`; assert the run completes and the artifact is written.
  Add a case where `inspect` fails once then passes, asserting the agent is
  re-prompted and the composition is ultimately persisted.
- Run with `vitest` from repo root; `npm run typecheck` clean.

## File Structure Summary

- Create: `apps/server/src/phases/compose-knowledge/{motion,typography,layout,transitions,effects}.md`
- Create: `apps/server/src/tools/reference-tool.ts` (the `read_reference` tool)
- Modify: `apps/server/src/phases/pi-compose-handler.ts` (system prompt core rules;
  register `read_reference`)
- Modify: `apps/server/src/render/quality-runner.ts` (add `inspect`)
- Create/modify tests: `reference-tool.test.ts`, `quality-runner.test.ts`,
  `pi-compose-handler.test.ts`

## Risks / Notes

- **Runtime md path under build/dist**: the plan must ensure the
  `compose-knowledge` files resolve at runtime under both `tsx` (src) and any built
  output. Prefer resolving relative to the module (`import.meta.url`) and, if a
  build step exists, copy the `.md` files into dist.
- **inspect runtime cost**: `inspect` runs headless Chrome (like `validate`, which
  already screenshots). Within the existing quality-runner timeout. Acceptable.
- **inspect false positives**: intentional entrance/exit overflow can be marked
  with `data-layout-allow-overflow`; the agent can address or mark on re-author.
