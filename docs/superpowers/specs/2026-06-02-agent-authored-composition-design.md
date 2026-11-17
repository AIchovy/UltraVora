# Agent-Authored Composition + Brand Asset Acquisition — Design

**Date:** 2026-06-02
**Status:** Approved (pending spec review)

## Problem

Rendered videos look nothing like they were "made with the hyperframes skill": all
scenes are plain text on a flat background, no motion, no logo, no use of the design
palette. Inspection of a real render confirms the cause.

`apps/server/src/render/composition-builder.ts` is a placeholder. It:

- renders each scene's `visual` field (a creative *directive*, e.g. "a chaotic array
  of glowing AI logos converging…") **literally as caption text** in a `<p>`;
- builds an **empty GSAP timeline** (`gsap.timeline({paused:true})` with zero tweens)
  → no entrance animations, no transitions, no motion at all;
- uses only `palette[0]`/`palette[1]` flatly, ignoring `mood`, `motionStyle`,
  `keyVisuals`, the full palette, and brand-accent intent;
- includes **no logo** (`brief.brandHints.logoUrl` is never downloaded or used).

This violates nearly every non-negotiable rule in the hyperframes authoring contract
(`hyperframes/skills/hyperframes/SKILL.md`): layout-before-animation, mandatory
per-scene entrance animations, mandatory scene transitions, timeline registration,
determinism, brand-faithful color.

Separately, the pipeline has **no way to acquire real brand assets**. `web_fetch`
returns page *text/HTML* only; there is no tool to download images, and
`brandHints.logoUrl` is a string that is never fetched.

## Goal

Produce videos that are genuinely animated, on-brand, and use the product's real logo
and imagery — authored by an agent following the hyperframes skill conventions, fed by
real assets gathered earlier in the pipeline.

## Scope

One end-to-end feature spanning two coordinated changes:

1. **Brand asset acquisition** in the research phase.
2. **Agent-authored composition** as a new dedicated `compose` phase that replaces the
   stub builder, including a `hyperframes lint`/`validate` feedback loop.

Out of scope (explicitly deferred): text-to-image generation, headless-browser
screenshots of the brand site, `hyperframes inspect` overflow auditing (may be added
later as an extra loop step).

## Pipeline Shape (Approach A — approved)

Insert a dedicated `compose` phase **after voiceover and before render**:

```
research → design → script → voiceover → compose → render
```

`compose` must run after `voiceover` so the agent can wire the narration `<audio>`
track into the composition. Rationale for a dedicated phase over folding into render:
authoring is an agentic, iterative, fallible step distinct from the deterministic
render; a separate phase gives it its own progress/gate/refinement (e.g. "make scene 2
punchier") and lets `render` re-run without re-authoring.

Artifact ownership moves accordingly:

- `compose` outputs `composition`.
- `render` outputs `mp4` only (was `["composition", "mp4"]`).

## Component 1 — Brand Asset Acquisition (research phase)

### New tool: `download_asset`

`apps/server/src/tools/research-tools.ts` — `makeDownloadAssetTool({ sessionId, workspaces, fetchBinary })`:

- Parameters: `{ url: string }`.
- Validates `http(s)` scheme (reuse the `web_fetch` URL guard).
- Fetches the binary body; enforces a **max size** (e.g. 10 MB) and an **allowlist of
  image content-types** (`image/png|jpeg|webp|gif|svg+xml`). Reject otherwise.
- Writes to a new workspace dir `assets/` under a sanitized, content-hashed filename
  (flat path; no `..`/separators — same guard as the narration filename check).
- Returns the **local relative path** (e.g. `assets/<hash>.png`) and detected type.

Requires a binary fetch capability. Extend the injected fetcher: add a `fetchBinary(url,
signal) → { status, contentType, bytes }` adapter in `apps/server/src/api/server.ts`
alongside the existing text `fetchAdapter`.

### WorkspaceManager

Add `assets` to `WorkspacePaths` and to the dirs created in `init()`
(`apps/server/src/workspace/workspace-manager.ts`).

### Research agent

Extend `SYSTEM_PROMPT` in `pi-research-handler.ts`: after fetching the URL, extract
candidate brand assets from the returned HTML — favicon, `og:image`, prominent
`<img>` logos/product shots — and call `download_asset` for the logo plus a small
number (≤ ~5) of key images. Register them in the brief.

### Brief schema (`packages/shared/src/brief.ts`)

- `brandHints.logoFile?: string` — local relative path to the downloaded logo.
- `sourceAssets.images` — entries reference **local files** (`assets/...`) rather than
  remote URLs (keep `logoUrl` as an optional provenance field).

`write_brief` tool params (`artifact-write-tools.ts`) updated to accept these fields.

## Component 2 — Compose Agent (new `compose` phase)

### Handler: `PiComposePhaseHandler`

`apps/server/src/phases/pi-compose-handler.ts`, mirroring the existing Pi handlers:

- Loads upstream artifacts: `brief`, `design`, `script`, and `narration` (if present).
- Resolves available asset file paths (logo, images) from the brief.
- Creates a Pi agent via `PiAgentFactory` with the compose system prompt and tools.
- Drives it with `runAgentToCompletion`, then runs the quality loop (below).
- Writes the `composition` artifact (`{ dir: "composition", entry: "index.html" }`)
  with lineage `design + script (+ narration)`.

### New tool: `write_composition_file`

`makeWriteCompositionFileTool({ sessionId, workspaces })`:

- Parameters: `{ path: string, content: string }`.
- Path is constrained to a flat or shallow path inside the session's `composition/`
  dir (reject `..`, absolute paths, escapes — same posture as `download_asset`).
- Writes the file (creating parent dirs). The agent calls it for `index.html` and any
  sub-composition/CSS files. Copies referenced assets from `assets/` into `composition/`
  as needed (or the prompt instructs referencing them by relative path — see below).

Asset access: the agent is **told the asset paths** in the prompt and references them by
relative path from `composition/`. The handler ensures referenced assets are available
alongside `index.html` (copy `assets/<file>` → `composition/<file>`), since hyperframes
expects media files at the project root next to `index.html`.

### Compose system prompt

Embeds a **distilled hyperframes authoring contract** (the source of truth is
`hyperframes/skills/hyperframes/SKILL.md`; we inline the load-bearing rules so the
server-side agent, which cannot invoke Claude Code skills, follows them):

- **Timeline contract:** every timeline `{ paused: true }`; register
  `window.__timelines["<composition-id>"]`; duration comes from `data-duration`, not
  GSAP length; no empty tweens.
- **Structure:** standalone `index.html` puts the `data-composition-id` div directly in
  `<body>` (no `<template>`); root carries `data-width`/`data-height`/`data-duration`;
  each scene is a clip with `id`, `data-start`, `data-duration`, `data-track-index`.
- **Layout before animation:** position elements at their hero-frame state in static
  CSS using `.scene-content { width:100%;height:100%;padding;display:flex;… }`;
  `position:absolute` only for decoratives.
- **Motion (non-negotiable):** every element animates IN via `gsap.from()`; **scene
  transitions are mandatory** (no jump cuts); **no exit animations** except the final
  scene; offset first tween 0.1–0.3s; vary eases.
- **Determinism:** no `Math.random()`/`Date.now()`; seeded PRNG if needed; no
  `repeat:-1`; synchronous timeline construction.
- **Brand fidelity:** use the **full** design palette/typography/mood/motionStyle;
  treat each scene's `visual` as a **directive to realize with CSS/SVG/GSAP**, NOT as
  literal on-screen text; embed the logo; honor accent intent (e.g. a highlighted word).
- **Sizing:** 60px+ headlines, 20px+ body for rendered video.

Inputs serialized into the prompt: full `design`, full `script` (scenes with
`visual` as directives + `onScreenText`), resolution, available asset relative paths,
and narration filename/duration if present.

### Quality feedback loop (v1 — approved)

After the agent signals completion:

1. Run `hyperframes lint` then `hyperframes validate` against `composition/` (reuse the
   forked-subprocess pattern from the render worker; capture stdout/stderr).
2. If either fails, feed the captured diagnostics back to the agent as a new user turn
   and let it edit files via `write_composition_file`.
3. Repeat up to **3 rounds**. If still failing, surface a `phase.error` with the last
   diagnostics. (`hyperframes inspect` is out of scope for v1.)

## Data / Type Changes

- `packages/shared/src/events.ts`: add `"compose"` to `PhaseIdSchema` (between
  `voiceover` and `render`); `PHASE_IDS` order updates automatically.
- `packages/shared/src/brief.ts`: `brandHints.logoFile`, local `sourceAssets.images`.
- `apps/server/src/phases/registry.ts`: insert `{ id: "compose", outputs:
  ["composition"] }` (no gate in v1, matching `render`); change `render` outputs to
  `["mp4"]`.
- `apps/server/src/intent/intent-router.ts`: ordering derives from `PHASE_IDS`; verify
  prev/next traverse `compose` correctly.
- `apps/server/src/compose-orchestrator.ts`: register the `compose` handler.
- `apps/web`: phase display / progress UI includes `compose` (it currently renders
  phase events generically; confirm no hardcoded phase list breaks).
- `apps/server/src/render/composition-builder.ts`: **removed**; the `RESOLUTIONS` map
  and any still-needed helpers (hex/font validation) move to a small shared util the
  compose handler can use for the root `data-width`/`data-height`.

## Render handler change

`render-handler.ts` no longer calls `buildComposition` or writes composition files.
It reads the existing `composition` artifact (written by the `compose` phase) and runs
the renderer on `composition/index.html` (output path already fixed to absolute). It
still writes the `mp4` artifact with lineage referencing the `composition` version.

## Error Handling

- `download_asset`: oversized/disallowed-type/failed fetches throw a clear tool error;
  the research agent proceeds without that asset (assets are best-effort, not fatal).
- compose: missing upstream artifact → throw (matches existing handlers). Quality-loop
  exhaustion → `phase.error`. Abort signal honored via the agent factory.
- `write_composition_file`/`download_asset` path escapes → reject with explicit error.

## Testing

- **`download_asset` unit:** size cap, content-type allowlist, path sanitization, file
  written under `assets/`, returns local path. Stub `fetchBinary`.
- **`write_composition_file` unit:** writes inside `composition/`, rejects `..`/absolute.
- **Compose handler unit:** with a stub model that calls `write_composition_file`,
  assert the `composition` artifact is written and the produced `index.html` satisfies a
  structural contract check — has a root `data-composition-id` with
  `data-width/height/duration`, each scene is a clip with `data-start`/`data-duration`,
  and the GSAP timeline registers `window.__timelines` and is **non-empty** (≥1 tween
  per scene). Stub the quality loop's subprocess to "pass".
- **Quality-loop unit:** stub lint/validate to fail once then pass; assert the agent is
  re-prompted with diagnostics and the loop converges; assert it gives up after N.
- **End-to-end:** research→design→script→(voiceover)→compose→render with the
  fake-renderer; assert the generated `composition/index.html` passes real
  `hyperframes validate`, and the mp4 artifact lands at the absolute workspace output
  path (regression guard already added).

## Decisions (locked for v1)

- `compose` has **no user-approve gate** (matches `render`); revisit if users want to
  edit the composition before render.
- Quality loop runs **3 rounds** max.
- Assets are **copied** from `assets/` into `composition/` (referenced by relative path
  next to `index.html`), because hyperframes expects media at the project root.
