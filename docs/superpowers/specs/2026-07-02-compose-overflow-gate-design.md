# Compose quality gate: surface element overflow + asset dimensions in prompt

**Date:** 2026-07-02
**Trigger:** Session `e871ba4d-5f0e-4f62-afeb-df8981061e3c` shipped a rendered video whose
Giggle Academy logo (936×168 lockup) overflowed the 1920px canvas in the first and last
scenes (rendered 2228.6px / 2507.1px wide, clipped ~154px / ~294px per side).

## Root cause (verified)

1. The compose agent sized the logo by height only (`height: 400px` / `450px`); the asset
   is a 5.57:1 wide lockup, so the implied width exceeded the canvas.
2. `hyperframes inspect` DID detect both cases — as `container_overflow` findings with
   severity **warning** (only text overflow is error severity). Without `--strict`,
   warnings exit 0 (`layout.ts`: `ok = errorCount === 0 && (!strict || warningCount === 0)`).
3. `HyperframesQualityRunner.check` treats only a non-zero exit as failure and never reads
   stdout otherwise, so the finding never reached the compose agent's fix loop.
4. Contributing: the compose prompt lists assets as `name (role)` with no pixel
   dimensions, so the LLM cannot know an asset's aspect ratio when sizing it.

## Approaches considered

1. **Run inspect with `--strict`.** Trivial, but ALL warnings block, including tiny
   tolerance-level bleeds and intentional decorative overflow — high false-positive risk,
   compose fix-loops on noise. Rejected.
2. **Parse inspect `--json` in quality-runner; promote only meaningful
   `container_overflow` findings to failures.** Targeted at the shipped bug class;
   threshold filters decorative noise; the existing `data-layout-allow-overflow` escape
   hatch (named in each finding's fixHint) lets the agent mark intentional overflow, so
   the loop converges. **Chosen.**
3. **Raise severity in the hyperframes CLI.** Touches the vendored/upstream project,
   affects all CLI users, needs a release; server pins npm versions. Rejected.

## Design

### A. Promote severe container overflow in the quality gate

New module `apps/server/src/render/inspect-overflow-check.ts` (mirrors
`scene-reveal-check.ts`):

- `findSevereContainerOverflows(inspectJsonStdout: string): string[]`
- Parses the inspect `--json` document; on any parse/shape failure returns `[]`
  (best-effort guard, same philosophy as the scene-reveal scan).
- Selects issues with `code === "container_overflow"` whose overflow on ANY side exceeds
  `max(12px, 2% of the container's corresponding dimension)` (width for left/right,
  height for top/bottom; missing containerRect ⇒ the 12px floor alone).
  For the 1920×1080 scene containers that is 38.4px horizontal / 21.6px vertical —
  drop-shadow/rounding bleeds stay warnings, a logo hanging 154px off-frame fails.
- Returns one formatted line per violation: time window, selector, container, per-side
  overflow px, and the CLI's own `fixHint` (which names `data-layout-allow-overflow`).

`HyperframesQualityRunner.check`: after an `inspect` run that exits **0**, feed stdout
through `findSevereContainerOverflows`; violations set `ok = false` and are appended to
diagnostics under an `[inspect]` header. Exit-non-zero behavior is unchanged.

### B. Asset pixel dimensions in the compose prompt

- New `apps/server/src/phases/asset-dimensions.ts`: `probeImageDimensions(path)` via
  `sharp(path).metadata()` (sharp is already a server dependency); returns
  `{width, height}` or `null` (non-image / unreadable).
- `pi-compose-handler`: probe each asset after it is copied into `composition/`;
  `availableAssets` entries gain optional `dimensions`.
- Extract the inline listing into exported `formatAssetsBlock(assets)`:
  `- logo.png (logo, 936×168px)` / `- pic.png (image)` when unknown.
- SYSTEM_PROMPT additions (FIT THE FRAME section):
  - The inspector now also fails on elements/images clipped by the frame or a clipping
    container (not just text).
  - Image-sizing rule: the asset list gives true pixel dimensions; respect aspect ratio —
    size wide assets by WIDTH with a max-width guard (height:auto), never by height alone
    without checking the implied width against the frame.

## Testing

1. `test/inspect-overflow-check.test.ts` — pure-function fixtures: severe overflow
   promoted; sub-threshold ignored; 2% scaling honored; missing containerRect uses 12px
   floor; other codes ignored; malformed JSON → `[]`; formatted line carries selector,
   overflow px and fixHint.
2. `test/quality-runner.test.ts` — inspect stub printing real-shaped JSON, exit 0:
   severe overflow → `ok=false` with `[inspect]` diagnostics; benign JSON → `ok=true`;
   non-JSON stdout → `ok=true`.
3. `test/asset-dimensions.test.ts` — sharp-generated PNG/JPEG probed correctly;
   non-image and missing files → `null`.
4. `test/pi-compose-handler.test.ts` — `formatAssetsBlock` unit tests; SYSTEM_PROMPT
   regression assertions for the image-sizing rule; handler-level test seeding a real
   936×168 PNG and capturing the prompt via a faux response factory to assert the
   dimensions reach the agent.
5. Manual end-to-end: run the new runner against the reassembled session
   `e871ba4d` composition — must fail naming `.s1-content` and `#logo-s5`.

## Out of scope

- Changes to the hyperframes CLI/vendored checkout.
- Retroactive fix/re-render of the shipped video (separate, user-facing decision).
