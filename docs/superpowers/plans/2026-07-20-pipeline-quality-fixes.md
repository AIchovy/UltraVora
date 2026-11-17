# Pipeline Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement every recommendation from `docs/reviews/2026-07-20-video-pipeline-quality-review.md` EXCEPT the compose visual self-critique (P0-1, explicitly excluded by the founder).

**Architecture:** Server-side changes across the phase handlers (research/design/script/voiceover/compose), the quality gate, the registry catalog, and the vendored skills/registry content. New leverage comes from wiring existing capabilities: `hyperframes capture --json` for deterministic brand extraction, pi-ai `ImageContent` for multimodal inputs, `hyperframes snapshot` for black-frame detection.

**Tech Stack:** TypeScript (ESM), vitest, typebox (tool schemas), zod (shared schemas), sharp, hyperframes CLI 0.6.63, pi-ai/pi-agent-core 0.78.

## Global Constraints

- All work on branch `claude/agent-harness-review-ce97fa` in this worktree; commit per task (TDD: failing test → impl → pass → commit).
- Schema changes must be backward compatible: new fields optional in zod + typebox mirrors.
- Test command: `pnpm -F @ultracreator/server test -- run <file>` (vitest).
- Never break the deterministic constraint-overlay in write_brief (userConstraints wins).
- Prompt text changes: keep the existing non-negotiable blocks intact unless the review names them as the defect.

---

### Task 1: Contrast gate (P0-4)
**Files:** Create `apps/server/src/render/contrast-check.ts`; Modify `apps/server/src/render/quality-runner.ts` (validate branch); Test `apps/server/test/contrast-check.test.ts`, extend `apps/server/test/quality-runner.test.ts`.
**Interfaces:** Produces `findContrastFailures(validateStdout: string): string[]` — one human-readable line per WCAG failure (selector, ratio, required). Wire like `findSevereContainerOverflows`: when `validate` exits 0, parse stdout; failures ⇒ `ok=false`, lines appended under `[validate] WCAG contrast failures…`.
Parser must tolerate unknown JSON shape: walk parsed JSON for objects with a contrast-ish kind/type/rule AND a numeric ratio; threshold 4.5 normal / 3.0 large (trust the CLI's own pass/fail flag when present, fall back to ratio<4.5). Non-JSON stdout ⇒ [].

### Task 2: Narration contract fix + pad disclosure (P1-8, P1-7c)
**Files:** Modify `apps/server/src/phases/narration-prompt.ts`; Test `apps/server/test/narration-prompt.test.ts`.
**Change:** Rewrite the block text: timeline stays authoritative for scene BOUNDARIES and audio clips, but explicitly (a) discloses that each narrated scene's window already includes ~1s of trailing silence (the transition window), (b) permits the incoming scene's transition/reveal to begin up to 0.8s before its data-start (crossfade overlap), (c) keeps EXACT audio `<audio data-start/duration>` values. Keep return contract `{block, totalDurationSec}` unchanged.

### Task 3: Script phase upgrade (P1-6, P1-7a/b)
**Files:** Modify `apps/server/src/phases/pi-script-handler.ts` (SYSTEM_PROMPT), `apps/server/src/tools/artifact-write-tools.ts` (makeWriteScriptTool validation); Test `apps/server/test/artifact-write-tools.test.ts`, `apps/server/test/pi-script-handler.test.ts`.
**Prompt adds:** narrative arc (hook ≤3s → problem → feature beats → proof → CTA hold ≥3s), scene-count ranges per duration (≤15s: 3-5; 30s: 5-7; 60s: 7-10), REQUIRED duration variation (no uniform slicing), onScreenText ≤6 words, narration written for the ear, word budget: narration ≈ durationSec × 2.4 words (state ±25% tolerance).
**Validation in write_script.execute:** for narrated scenes compute `words/2.4`; if any scene deviates >35% from durationSec OR the estimated narration total deviates >25% from totalSec, throw an Error listing offending scenes with target word counts (agent retries). Scenes without narration skip the check.

### Task 4: TTS delivery style (P1-7d)
**Files:** Modify `apps/server/src/providers/types.ts` (TTSInput.styleInstruction?: string), `apps/server/src/providers/gemini-tts.ts` (prepend `${style}: ` Gemini natural-language style pattern), `apps/server/src/phases/voiceover-handler.ts` (derive from design.mood/motionStyle: `Say in a <mood> tone, matching a <motionStyle> promo pace`); Test `apps/server/test/gemini-tts.test.ts` + voiceover handler test.
Design artifact read is best-effort (voiceover works without design).

### Task 5: Research capture + brand extraction (P0-2, styleIntent)
**Files:** Create `apps/server/src/tools/capture-tools.ts`; Modify `packages/shared/src/brief.ts` (+`styleIntent: z.string().optional()`), `apps/server/src/tools/artifact-write-tools.ts` (briefParameters + passthrough), `apps/server/src/tools/research-tools.ts` (download_asset: + image block + sharp dominant colors + ico allowlist; read_upload: binary images → ImageContent), `apps/server/src/phases/pi-research-handler.ts` (prompt rewrite + tool wiring); Test `apps/server/test/capture-tools.test.ts`, extend research tests.
**capture_website tool:** params {url}; spawns `npx --package=hyperframes hyperframes capture <url> -o <workspace-root>/capture --json --max-screenshots 8` (timeout 180s, injectable commandFor for tests). On success reads `capture/extracted/tokens.json`, `fonts-manifest.json`, first lines of `visible-text.txt`; picks hero screenshot + logo/asset contact sheet; returns content = [summary text incl. tokens/fonts/asset list, up to 3 ImageContent (sharp-downscaled ≤1280px JPEG ≤400KB)]. Failure ⇒ throw (research falls back to web_fetch path).
**Prompt rewrite:** URL present ⇒ capture_website FIRST; brandHints.colors = 3-6 hexes from tokens.json ordered background/foreground/accent (with provenance rule); brandHints.fonts from fonts-manifest; sourceAssets from capture assets dir (verify with the returned images); styleIntent = user's aesthetic words verbatim; download_asset only as fallback / for og:image; keep low-content exclusion rule.

### Task 6: Design phase overhaul (P0-3)
**Files:** Modify `packages/shared/src/design.ts` (optional: colorRoles{background,surface,foreground,accent}, typeScale{display,heading,body,caption}?, motion{energy,easing,principles[]}?, imageStyle?: string), `apps/server/src/tools/artifact-write-tools.ts` (designParameters mirror), `apps/server/src/phases/pi-design-handler.ts` (system prompt rewrite + image inputs), `apps/server/src/phases/pi-handler-helpers.ts` (runAgentForArtifact `images?: ImageContent[]` → `agent.prompt(prompt, images)`); Test pi-design-handler + artifact-write-tools tests.
**Prompt content (distilled from vendored house-style.md/typography.md):** declare one background/one foreground/one accent before styling (60-30-10); WCAG 4.5:1 body 3:1 display against the CHOSEN background; fonts MUST be Google-Fonts-hosted, extreme weight contrast, and NEVER from the banned list (Inter, Roboto, Open Sans, Noto Sans, Arimo, Lato, Source Sans, PT Sans, Nunito, Poppins, Outfit, Sora, Playfair Display, Cormorant Garamond, Bodoni Moda, EB Garamond, Cinzel, Prata, Syne); internally consider 3 distinct directions, commit to one; palette anchored on brandHints/attached imagery, no invented hues unless brief has none; fill colorRoles/typeScale/motion/imageStyle (imageStyle = one reusable style suffix for all generated imagery).
**Images in:** logo file (brandHints.logoFile) + up to 2 capture screenshots from `<workspace>/capture/screenshots/`, downscaled via sharp, attached to the design agent prompt.

### Task 7: Compose context enrichment (P1-5, P2 sweep pollution, image style)
**Files:** Modify `apps/server/src/phases/pi-compose-handler.ts` (brief block in contextParts; sweep re-probe; pass styleHint), `apps/server/src/tools/image-tools.ts` (opts.styleHint appended to prompt), extract `isLowContentImage` from research-tools into `apps/server/src/tools/image-quality.ts` (re-export from research-tools); Test pi-compose-handler + generate-image-tool tests.
**Brief block:** product name/tagline/category, audience, keyMessages, brandHints.colors+fonts, sourceAssets.copy (≤10 lines), styleIntent.
**Sweep:** files failing isLowContentImage get role `"decorative-only (near-blank)"` instead of `"image"`.

### Task 8: Design-fidelity static check (P2)
**Files:** Create `apps/server/src/render/design-fidelity-check.ts`; wire in `apps/server/src/phases/pi-compose-handler.ts` validation loop; Test `apps/server/test/design-fidelity-check.test.ts`.
**Interfaces:** `findDesignFidelityViolations(files: {path,text}[], design: Design): string[]`.
Extract #hex/rgb() literals + font-family stacks from html/css. Colors pass if: in palette/colorRoles (ΔHue ≤ 18° at similar sat, or any-lightness tint/shade of a palette hue), near-neutral (sat < 12%), or alpha variant. Fonts pass if family (first non-generic) ∈ design typography or generic. Violations feed the fix loop once (guard: only append on the first otherwise-ok round to avoid loops).

### Task 9: Registry aspect filter + showcase labeling (P1-10b)
**Files:** Modify `apps/server/src/registry/registry-loader.ts` (`formatRegistryCatalogForPrompt(entries, opts?: {width,height})` — drop blocks whose orientation mismatches the composition; annotate `showcase`-tagged blocks with "(showcase demo — recreate the effect, don't embed as-is)"), `apps/server/src/phases/pi-compose-handler.ts` (pass resolution); Test `apps/server/test/registry-loader.test.ts` (create if absent).

### Task 10: Caption/component sanitization (P1-10a) — subagent-able
**Files:** All `apps/server/src/registry/vendor/components/caption-*/{*.html}` (+ any other component with `<link` font loads).
Remove `<link rel=preconnect|stylesheet>` Google-Fonts tags; `font-family: "X", …` → `font-family: var(--caption-font, inherit)`; primary hardcoded text/highlight colors → `var(--caption-color, <orig>)` / `var(--caption-accent, <orig>)`. demo.html files may keep links (not installed) — verify what add_registry_item actually copies first and only sanitize installed files.

### Task 11: Skills pipeline sanitization (P1-9) — subagent-able
**Files:** `apps/server/src/skills/vendor/hyperframes/hyperframes/{SKILL.md,visual-styles.md,references/transitions.md,references/beat-direction.md,references/transitions/catalog.md}`, `apps/server/src/skills/vendor/hyperframes/hyperframes-registry/SKILL.md`.
(a) visual-styles.md: replace every `fontFamily: Inter` with a style-appropriate non-banned Google Font; bump web-scale sizes to video scale (body ≥20px, headline ≥60px) where presets state sizes. (b) Replace HyperShader/@hyperframes/shader-transitions sections with: "WebGL shader transitions are NOT available in this environment. Use the CSS transition catalog (css-*.md) — it covers dissolve/wipe/3d/light/distortion equivalents." Keep CSS guidance intact. (c) SKILL.md checklist: CLI self-check items → "the system runs lint/validate/inspect automatically after you finish; fix what it reports". Remove design-picker/user-gate workflow steps or mark "(interactive use only — skip in pipeline)". (d) hyperframes-registry/SKILL.md: curl/CLI discovery → add_registry_item flow; fix the data-track-index z-order claim to match the main skill (track = clip lane; z-order via z-index/DOM).

### Task 12: Render quality default high (P2)
**Files:** Modify `apps/server/src/compose-orchestrator.ts` (renderQuality default "high" when unset), check env wiring in `apps/server/src/api/server.ts`; Test compose-orchestrator-integration if it asserts quality.

### Task 13: Black-frame detection (P2)
**Files:** Create `apps/server/src/render/blank-frame-check.ts`; Modify `apps/server/src/render/quality-runner.ts` (optional post-pass) or `pi-compose-handler`; Test `apps/server/test/blank-frame-check.test.ts`.
Parse scene clips (data-start/data-duration, non-audio) from index.html; midpoints → `npx --package=hyperframes hyperframes snapshot <dir> --at t1,t2,… --describe false`; for each PNG compute luminance stddev via sharp `stats()`; stddev < 6 AND mean < 20 on a scene with content ⇒ diagnostic line. Injectable command + fs for tests; snapshot failure ⇒ skip check (never block on tooling).

**Not doing (report as skipped):** compose visual self-critique (excluded by user); web approval-gate image display (frontend app change — spawn as follow-up task).
