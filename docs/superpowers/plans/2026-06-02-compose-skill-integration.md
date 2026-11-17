# Compose-Phase Skill Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the compose phase author materially better videos by integrating the gsap/hyperframes skill knowledge (vendored + a `read_reference` tool), adding the `hyperframes inspect` layout check to the quality loop, and fixing the exit/transition rules the agent currently violates.

**Architecture:** Vendor distilled skill knowledge as five markdown files under `apps/server/src/phases/compose-knowledge/`. Give the compose agent a `read_reference` tool that returns a file by topic key. Tighten the compose `SYSTEM_PROMPT` to carry non-negotiable core rules and list the reference keys. Extend `HyperframesQualityRunner` to also run `inspect`, feeding its diagnostics into the existing fix loop.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Node, run via `tsx` (no build step). Pi agent framework (`@earendil-works/pi-agent-core`, `typebox` for tool params). Tests: `vitest` run from repo ROOT. Typecheck: `npm run typecheck`.

**Conventions (read before starting):**
- Tools follow the pattern in `apps/server/src/tools/composition-tools.ts`: `Type.Object` params, `AgentTool<typeof params>`, `execute: async (_callId, params) => ({ content: [{ type: "text", text }], details })`, throw `Error` on invalid input.
- Server runs via `tsx src/api/server.ts` (ESM, no build). Resolve vendored markdown relative to the module with `import.meta.url` so it is cwd-independent; no dist-copy step is required.
- Run a single test file: `npx vitest run apps/server/test/<name>.test.ts` from the repo root (`/path/to/UltraVora`).
- Typecheck everything: `npm run typecheck` from the repo root.

---

### Task 1: Vendored knowledge base (five markdown files)

**Files:**
- Create: `apps/server/src/phases/compose-knowledge/motion.md`
- Create: `apps/server/src/phases/compose-knowledge/typography.md`
- Create: `apps/server/src/phases/compose-knowledge/layout.md`
- Create: `apps/server/src/phases/compose-knowledge/transitions.md`
- Create: `apps/server/src/phases/compose-knowledge/effects.md`
- Test: `apps/server/test/compose-knowledge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/compose-knowledge.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../src/phases/compose-knowledge/", import.meta.url));

const required: Record<string, RegExp> = {
  "motion.md": /position parameter|build.*breathe.*resolve/i,
  "typography.md": /banned/i,
  "layout.md": /Layout.?Before.?Animation/i,
  "transitions.md": /exit animations? (are )?banned|transition is the exit/i,
  "effects.md": /typewriter/i,
};

describe("compose-knowledge vendored docs", () => {
  it("ships all five topic files with their key content", () => {
    for (const [file, marker] of Object.entries(required)) {
      const path = dir + file;
      expect(existsSync(path), `${file} must exist`).toBe(true);
      expect(readFileSync(path, "utf8")).toMatch(marker);
    }
  });

  it("typography.md lists the banned AI-default fonts", () => {
    const t = readFileSync(dir + "typography.md", "utf8");
    for (const font of ["Inter", "Roboto", "Outfit", "Poppins", "Syne"]) {
      expect(t).toContain(font);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/compose-knowledge.test.ts`
Expected: FAIL — files do not exist yet.

- [ ] **Step 3: Create `motion.md`**

```markdown
# Motion (gsap + motion principles)

Distilled for the compose phase. Apply deliberately — do not default.

## Vary everything (the #1 quality lever)
- **Eases:** no more than 2 independent tweens may share an ease in a scene. Vary like font weights.
- **Durations:** the slowest scene should be ~3× the fastest. Fast 0.15–0.3s (energy), medium 0.3–0.5s (most content), slow 0.5–0.8s (gravity/luxury), very slow 0.8–2.0s (cinematic).
- **Entrance direction:** don't enter every element with `y:30, opacity:0`. Mix: from left, from right, from scale, opacity-only, letter-spacing.
- **Stagger rhythm:** each scene gets its own. Total stagger sequence under 500ms regardless of item count.

## Easing is emotion
- `.out` for entrances (starts fast, decelerates — responsive). This is the default for elements appearing.
- `.in` for exits (accelerates away).
- `.inOut` for elements moving between positions.
- Getting this backwards (ease-in for entrances) feels sluggish. Built-in eases: power1–power4, back, bounce, circ, elastic, expo, sine — each with `.in`/`.out`/`.inOut`.

## Scene structure: build / breathe / resolve
- **Build (0–30%):** elements enter, staggered. Don't dump everything at once.
- **Breathe (30–70%):** content visible, alive with ONE ambient motion (slow pan / subtle rotation / scale push / nothing — stillness after motion is powerful).
- **Resolve (70–100%):** decisive end. Exits are faster than entrances (a card enters in 0.4s, leaves in 0.25s).

## Choreography is hierarchy
- The element that moves first reads as most important. Stagger in order of importance, not DOM order.
- Don't wait for completion — overlap entries.

## GSAP essentials
- **Timeline position parameter** (3rd arg) is how you sequence: absolute `1`; relative `"+=0.5"` / `"-=0.2"`; label `"intro+=0.3"`; alignment `"<"` (same start as previous), `">"` (after previous ends), `"<0.2"` (0.2s after previous starts). Prefer this over chaining with `delay`.
- **Labels:** `tl.addLabel("intro", 0)` then `tl.to(".a", {...}, "intro")`.
- **Transform aliases** (cheap, on the compositor): `x`, `y`, `scale`, `rotation`, `xPercent`, `transformOrigin`. Avoid animating `width/height/top/left`.
- **autoAlpha** instead of `opacity` (also toggles visibility at 0).
- **stagger** object: `{ each: 0.08, from: "center" }` or `{ amount: 0.3, from: "start" }`.
- **gsap.defaults({ duration, ease })** on the timeline constructor to set scene defaults.
- Determinism: NO `Math.random()`, `Date.now()`, or `repeat: -1`. Use a seeded PRNG (mulberry32) if you need pseudo-random; compute finite repeat counts.
```

- [ ] **Step 4: Create `typography.md`**

```markdown
# Typography

The compiler embeds supported fonts — just write `font-family` in CSS.

## Banned fonts (instant AI design tell — never use)
Inter, Roboto, Open Sans, Noto Sans, Arimo, Lato, Source Sans, PT Sans, Nunito, Poppins, Outfit, Sora, Playfair Display, Cormorant Garamond, Bodoni Moda, EB Garamond, Cinzel, Prata, Syne. **Syne especially.**

Pick something with character that fits the content's register instead.

## Pairing rules
- **Don't pair two sans-serifs.** Cross the boundary: serif + sans, or sans + mono.
- One expressive font per scene — one performs, one recedes.
- Never pair two *similar* fonts (two geometric sans, two transitional serifs) — friction without hierarchy. Either one font at two weights, or contrast on multiple axes (serif+sans, condensed+wide, geometric+humanist).

## Weight & size (video, not web)
- **Extreme weight contrast:** 300 vs 900, not 400 vs 700. The difference must read in motion at a glance.
- Headlines 60px+, body 20px+, data labels 16px+. Never 14px.
- Display tracking tighter than web: -0.03em to -0.05em (encoding compresses letter detail).

## Dark backgrounds
- Light-on-dark reads heavier — use ~350 weight for body instead of 400.
- Light halos tighten spacing — add 0.05–0.1 to `line-height`, and ~0.01em `letter-spacing` at display sizes.

## Data
- `font-variant-numeric: tabular-nums` on any vertically-stacked numbers (stats, timers, scoreboards) so columns align.
```

- [ ] **Step 5: Create `layout.md`**

```markdown
# Layout & Visual Composition

## Layout Before Animation (build the end state first)
Position every element where it sits at its **most visible moment** (the hero frame) as static HTML+CSS, BEFORE adding any GSAP. Then animate INTO that position with `gsap.from()`, and (only on the final scene) OUT with `gsap.to()`. The CSS position is ground truth; the tween is the journey.

- The content container fills the scene: `width:100%; height:100%; padding:Npx; display:flex; flex-direction:column; gap:Npx; box-sizing:border-box`. Use padding to push content inward.
- **NEVER** `position:absolute; top:Npx` on a content container — it overflows when content is taller than expected. Reserve `position:absolute` for decoratives only.

## Fill the frame — video frames are not web pages
- **Two focal points minimum per scene.** Never a single text block floating in empty space.
- **Hero text occupies 60–80% of width.** Don't use web-sized elements.
- **Three layers minimum per scene:** background treatment (glow / oversized faded type / color panel) + foreground content + accent elements (dividers, labels, data bars).
- **Anchor to edges** (pin left/top or right/bottom). Centered-and-floating is a web pattern.
- **Split frames / zone layouts:** data panel left + content right; metadata top bar + full-width below. Not centered stacks.
- Use structural elements (rules, dividers, border panels) — they guide the eye and animate well (`scaleX` from 0).

## Background layer (every scene needs depth)
Without persistent decoratives, scenes feel empty during entrance staggering. Add 2–5 per scene, each with slow ambient GSAP motion (breathe / drift / pulse — static decoratives feel dead):
- Radial glows (accent-tinted, low opacity, breathing scale)
- Ghost text (theme words at 3–8% opacity, very large, slow drift)
- Hairline accent rules (subtle pulse), grain/noise, geometric shapes, thematic motifs.

## Lazy defaults to QUESTION (AI design tells)
Pause before using any of these — is it deliberate for THIS content, or a default?
- Gradient text (`background-clip:text` + gradient)
- Left-edge accent stripes on cards
- Cyan-on-dark / purple-to-blue gradients / generic neon
- Pure `#000`/`#fff` (reads as "nothing loaded" — tint toward your accent hue)
- **Identical card grids (same-size cards repeated)** — and never leave a card empty; every visible container needs real content (image, icon, text, graphic)
- Everything centered with equal weight (lead the eye somewhere)

## Color
- One accent hue, same background across all scenes. Tint neutrals toward the accent.
- Contrast is enforced by `hyperframes validate` (WCAG AA). Text must be readable with decoratives removed.
```

- [ ] **Step 6: Create `transitions.md`**

```markdown
# Scene Transitions

A transition tells the viewer how two scenes relate. Choose by what the content is doing emotionally.

## Non-negotiable rules for multi-scene compositions
1. **Always use transitions between scenes.** No jump cuts.
2. **Every scene uses entrance animations** — every element animates IN via `gsap.from()`. Nothing pops in fully-formed.
3. **Exit animations are BANNED except the final scene.** Do NOT `gsap.to(opacity:0)` / slide a scene out before a transition. The transition IS the exit; the outgoing scene must be fully visible when the transition starts.
4. **Final scene only** may fade elements out (e.g. fade to black).

## Pick ONE primary (60–70% of changes) + 1–2 accents — never a different one per scene

| Energy | CSS primary | Accent | Duration | Easing |
| --- | --- | --- | --- | --- |
| Calm (wellness, luxury, brand story) | Blur crossfade, focus pull | Light leak, circle iris | 0.5–0.8s | `sine.inOut`, `power1` |
| Medium (corporate, SaaS, explainer) | Push slide, staggered blocks | Squeeze, vertical push | 0.3–0.5s | `power2`, `power3` |
| High (promo, sports, launch) | Zoom through, overexposure | Staggered blocks, gravity drop | 0.15–0.3s | `power4`, `expo` |

Narrative: opening = your most distinctive transition; between related points = the primary (consistent); topic change = something different (signals a reset); climax = boldest accent; outro = slowest/simplest (crossfade or dip to black).

## Presets
`snappy` 0.2s power4.inOut · `smooth` 0.4s power2.inOut · `gentle` 0.6s sine.inOut · `luxe` 0.7s power1.inOut · `instant` 0.15s expo.inOut.

## Recipe: blur crossfade (calm/premium)
```js
// T = transition start; `old` exiting scene-inner, `new` incoming (starts opacity:0)
tl.to("#old", { opacity: 0, filter: "blur(20px)", duration: 0.6, ease: "sine.inOut" }, T);
tl.fromTo("#new", { opacity: 0, filter: "blur(20px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "sine.inOut" }, T);
```

## Recipe: push slide (medium/editorial)
```js
tl.to("#old", { xPercent: -100, duration: 0.45, ease: "power3.inOut" }, T);
tl.fromTo("#new", { xPercent: 100 }, { xPercent: 0, duration: 0.45, ease: "power3.inOut" }, T);
```

## Recipe: staggered blocks cover (medium/tech) — topic change
```js
// 8 full-height columns (NOT thin strips) sweep across, hiding the swap
tl.fromTo(".cover-col", { scaleY: 0, transformOrigin: "bottom" },
  { scaleY: 1, duration: 0.3, stagger: 0.04, ease: "power2.in" }, T);
tl.set("#old", { opacity: 0 }, T + 0.34);            // swap hidden behind cover
tl.set("#new", { opacity: 1 }, T + 0.34);
tl.to(".cover-col", { scaleY: 0, transformOrigin: "top", duration: 0.3, stagger: 0.04, ease: "power2.out" }, T + 0.36);
```

Scene visibility: scene 1 visible by default; scenes 2+ start `opacity:0` on the container and are revealed by the timeline.
```

- [ ] **Step 7: Create `effects.md`**

```markdown
# Drop-in Effects

Deterministic, seekable, registered via `window.__timelines`.

## Typewriter (GSAP TextPlugin)
```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/TextPlugin.min.js"></script>
<script>gsap.registerPlugin(TextPlugin);</script>
```
```html
<span id="typed"></span><span id="cursor" class="cursor-blink">|</span>
```
```css
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
.cursor-blink { animation: blink 0.8s step-end infinite; }
.cursor-solid { animation: none; opacity: 1; }
```
```js
const text = "Seriously great content";
const cps = 12; // 3-5 dramatic · 8-12 conversational · 15-20 energetic
const dur = text.length / cps;
tl.call(() => cursor.classList.replace("cursor-blink", "cursor-solid"), [], 0.3);
tl.to("#typed", { text: { value: text }, duration: dur, ease: "none" }, 0.3);
tl.call(() => cursor.classList.replace("cursor-solid", "cursor-blink"), [], 0.3 + dur);
```
Rules: one cursor visible at a time; cursor blinks when idle; no gap between text and cursor (elements flush in HTML).

## Audio visualizer (pre-extracted data)
Pre-extract amplitude/bands to JSON, then drive rendering from the timeline. Load data **synchronously** (inline or sync XHR) — never async `fetch()`, because the capture engine reads `window.__timelines` synchronously after load.
```js
for (let f = 0; f < AUDIO_DATA.totalFrames; f++) {
  tl.call(() => { /* draw canvas using AUDIO_DATA.frames[f].rms / .bands */ }, [], f / AUDIO_DATA.fps);
}
```
Bass drives big moves (scale/glow), treble drives detail (shimmer), rms drives globals (brightness). Pick 2–3 properties; keep minimums above zero so quiet sections stay alive.
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run apps/server/test/compose-knowledge.test.ts`
Expected: PASS (both tests).

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/phases/compose-knowledge/ apps/server/test/compose-knowledge.test.ts
git commit -m "feat(server): vendor distilled gsap/hyperframes compose knowledge"
```

---

### Task 2: `read_reference` tool

**Files:**
- Create: `apps/server/src/tools/reference-tool.ts`
- Test: `apps/server/test/reference-tool.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/reference-tool.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReadReferenceTool, REFERENCE_TOPICS } from "../src/tools/reference-tool.js";

describe("makeReadReferenceTool", () => {
  it("exposes the five topic keys", () => {
    expect(REFERENCE_TOPICS).toEqual(["motion", "typography", "layout", "transitions", "effects"]);
  });

  it("returns the file content for a known topic (from an override dir)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uc-ref-"));
    writeFileSync(join(dir, "motion.md"), "MOTION DOC BODY");
    const tool = makeReadReferenceTool({ dir });
    const res = await tool.execute("c1", { topic: "motion" });
    expect(res.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("MOTION DOC BODY") });
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws on an unknown topic", async () => {
    const tool = makeReadReferenceTool();
    await expect(tool.execute("c1", { topic: "bogus" } as never)).rejects.toThrow(/unknown reference topic/i);
  });

  it("resolves the real vendored docs by default", async () => {
    const tool = makeReadReferenceTool();
    const res = await tool.execute("c1", { topic: "typography" });
    expect(res.content[0].text).toMatch(/banned/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/reference-tool.test.ts`
Expected: FAIL — module `reference-tool.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// apps/server/src/tools/reference-tool.ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export const REFERENCE_TOPICS = ["motion", "typography", "layout", "transitions", "effects"] as const;
export type ReferenceTopic = (typeof REFERENCE_TOPICS)[number];

const FILES: Record<ReferenceTopic, string> = {
  motion: "motion.md",
  typography: "typography.md",
  layout: "layout.md",
  transitions: "transitions.md",
  effects: "effects.md",
};

// Default location of the vendored knowledge, resolved relative to THIS module
// (cwd-independent; works under tsx with no build step).
const DEFAULT_DIR = fileURLToPath(new URL("../phases/compose-knowledge/", import.meta.url));

const parameters = Type.Object({
  topic: Type.Union(
    REFERENCE_TOPICS.map((t) => Type.Literal(t)),
    {
      description:
        "Which reference to read: 'motion' (gsap timelines/easing + motion principles), " +
        "'typography' (font pairing, banned fonts, weights), 'layout' (layout-before-animation, " +
        "visual composition, background layer, anti-patterns), 'transitions' (energy table, " +
        "exit rules, recipes), 'effects' (typewriter, audio visualizer).",
    },
  ),
});

export interface ReadReferenceToolOptions {
  /** Override the knowledge directory (tests). Defaults to the vendored dir. */
  dir?: string;
}

export function makeReadReferenceTool(
  opts: ReadReferenceToolOptions = {},
): AgentTool<typeof parameters> {
  const dir = opts.dir ?? DEFAULT_DIR;
  return {
    name: "read_reference",
    label: "Read Reference",
    description:
      "Read a distilled gsap/hyperframes reference doc before authoring. Call this for the " +
      "topics relevant to the composition (e.g. 'transitions' and 'motion' for any multi-scene video).",
    parameters,
    execute: async (_callId, params) => {
      const file = FILES[params.topic as ReferenceTopic];
      if (!file) throw new Error(`Unknown reference topic: ${String(params.topic)}`);
      const text = await readFile(join(dir, file), "utf8");
      return {
        content: [{ type: "text", text }],
        details: { topic: params.topic, bytes: Buffer.byteLength(text, "utf8") },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/test/reference-tool.test.ts`
Expected: PASS (all four).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `Type.Union(array, options)` typing complains, the array form is supported by typebox; ensure the import is `import { Type } from "typebox";` matching `composition-tools.ts`.)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/tools/reference-tool.ts apps/server/test/reference-tool.test.ts
git commit -m "feat(server): add read_reference tool for compose knowledge"
```

---

### Task 3: Add `inspect` to the quality runner

**Files:**
- Modify: `apps/server/src/render/quality-runner.ts:13` (the `QualityCheckKind` type), `:23-25` (`defaultCommand`), `:65` (the check loop array)
- Test: `apps/server/test/quality-runner.test.ts`

- [ ] **Step 1: Write the failing test (add two cases to the existing file)**

Append these inside the existing `describe("HyperframesQualityRunner.check", ...)` block in `apps/server/test/quality-runner.test.ts`:

```ts
  it("runs inspect after lint and validate", async () => {
    const kinds: string[] = [];
    const runner = new HyperframesQualityRunner({
      commandFor: (kind, _dir) => {
        kinds.push(kind);
        return ["node", "-e", "process.exit(0)"];
      },
    });
    const res = await runner.check("/tmp/whatever", new AbortController().signal);
    expect(res.ok).toBe(true);
    expect(kinds).toEqual(["lint", "validate", "inspect"]);
  });

  it("reports ok=false and captures output when inspect exits non-zero", async () => {
    const runner = new HyperframesQualityRunner({
      commandFor: (kind, _dir) =>
        kind === "inspect"
          ? ["node", "-e", "console.log('OVERFLOW at t=5.3s'); process.exit(1)"]
          : ["node", "-e", "process.exit(0)"],
    });
    const res = await runner.check("/tmp/whatever", new AbortController().signal);
    expect(res.ok).toBe(false);
    expect(res.diagnostics).toMatch(/OVERFLOW/);
    expect(res.diagnostics).toMatch(/inspect/i);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/quality-runner.test.ts`
Expected: FAIL — `kinds` is `["lint","validate"]` (no `inspect`), and the inspect-failure case passes because inspect never runs.

- [ ] **Step 3: Implement — extend the type and loop**

In `apps/server/src/render/quality-runner.ts`, change the `QualityCheckKind` type:

```ts
export type QualityCheckKind = "lint" | "validate" | "inspect";
```

`defaultCommand` already generalizes over `kind`, so it needs no change (it produces `["npx", "--package=hyperframes", "hyperframes", kind, "--json", dir]`, and `hyperframes inspect --json <dir>` is the correct invocation).

Change the loop array in `check()` from:

```ts
    for (const kind of ["lint", "validate"] as const) {
```

to:

```ts
    for (const kind of ["lint", "validate", "inspect"] as const) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/test/quality-runner.test.ts`
Expected: PASS (all four — the two original plus the two new).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/render/quality-runner.ts apps/server/test/quality-runner.test.ts
git commit -m "feat(server): run hyperframes inspect in the compose quality loop"
```

---

### Task 4: Wire `read_reference` + tighten the compose system prompt

**Files:**
- Modify: `apps/server/src/phases/pi-compose-handler.ts` (import + register tool; replace `SYSTEM_PROMPT`)
- Test: `apps/server/test/pi-compose-handler.test.ts` (add one case)

- [ ] **Step 1: Write the failing test (add one case to the existing describe block)**

Add this test inside `describe("PiComposePhaseHandler", ...)` in `apps/server/test/pi-compose-handler.test.ts`. It drives a faux model that first calls `read_reference`, then authors a valid composition — proving the tool is registered and the run still converges:

```ts
  it("exposes read_reference and still authors the composition", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_reference", { topic: "transitions" })),
      fauxAssistantMessage(fauxText("got it")),
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seed(store, wm);

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/pi-compose-handler.test.ts`
Expected: FAIL — the agent calls `read_reference` but the tool is not registered, so the tool call errors / the run does not converge as asserted.

- [ ] **Step 3: Register the tool**

In `apps/server/src/phases/pi-compose-handler.ts`, add the import near the other tool imports:

```ts
import { makeReadReferenceTool } from "../tools/reference-tool.js";
```

Change the `tools` array (currently just `makeWriteCompositionFileTool(...)`) to:

```ts
    const tools = [
      makeWriteCompositionFileTool({ sessionId: ctx.sessionId, workspaces: ctx.workspaces }),
      makeReadReferenceTool(),
    ];
```

- [ ] **Step 4: Replace `SYSTEM_PROMPT` with the tightened core rules**

Replace the entire `SYSTEM_PROMPT` constant in `apps/server/src/phases/pi-compose-handler.ts` with:

```ts
const SYSTEM_PROMPT = `You are the COMPOSE phase of a promo-video pipeline. You author a
hyperframes composition: a standalone index.html that renders to an animated, on-brand
video. You CANNOT run shell commands or skills — follow this contract exactly.

Write files with the write_composition_file tool. Author index.html (and optional CSS /
sub-composition files). Reference media assets by their bare filename (they sit next to
index.html).

BEFORE AUTHORING, read the references you need with the read_reference tool. At minimum
read "transitions" and "motion" for any multi-scene video, and "layout" + "typography"
for the visual design. Topics: motion, typography, layout, transitions, effects.

TIMELINE CONTRACT (non-negotiable):
- Load GSAP from a CDN <script>.
- Create exactly one timeline per composition: gsap.timeline({ paused: true }).
- Register it: window.__timelines["main"] = tl;  (id must match data-composition-id)
- The composition duration comes from the root's data-duration, NOT from GSAP length.
- Never leave the timeline empty.

STRUCTURE:
- The root element carries data-composition-id="main", data-start="0",
  data-duration="<totalSec>", data-width="<W>", data-height="<H>", placed directly in
  <body> (no <template> for a standalone file).
- Each scene is a clip element with a unique id, data-start, data-duration, and
  data-track-index. Audio (if any) is a clip with data-track-index="0".

LAYOUT BEFORE ANIMATION:
- Position every element at its final (hero-frame) state in static CSS first.
- Content containers fill the scene: width:100%; height:100%; padding; display:flex; gap.
  Use position:absolute ONLY for decoratives — never for a content container.
- Fill the frame: 2+ focal points and 3+ layers per scene (background treatment +
  content + accents). Anchor content to edges; avoid a single centered floating block.
- Every scene needs a background/ambient layer (2-5 decoratives with slow motion) — a
  bare dark background reads as "nothing loaded".

NO EMPTY CONTAINERS (non-negotiable):
- Never render an empty styled box/card/panel — a border alone renders as a black box.
  Every visible container holds an image, icon, text, or graphic. Fill card grids cell
  by cell, or use fewer cells. Never repeat identical same-size cards as a default.

MOTION (non-negotiable):
- Every visible element animates IN via gsap.from(). Offset the first tween 0.1-0.3s.
- Vary eases (no more than 2 tweens share an ease per scene), durations, and entrance
  directions. Use .out for entrances, .in for exits, .inOut for moves.

TRANSITIONS (non-negotiable):
- Always transition between scenes — no jump cuts. Pick ONE primary transition by energy
  plus 1-2 accents (see the transitions reference). 
- Exit animations are BANNED except on the FINAL scene. The transition IS the exit; the
  outgoing scene must be fully visible when the transition starts.

BRAND FIDELITY:
- Use the FULL design palette, typography, mood, and motionStyle.
- Treat each scene's "visual" field as a DIRECTIVE to realize with CSS/SVG/GSAP — it is
  NOT literal on-screen text. The on-screen text is the scene's onScreenText field.
- Embed the logo asset. Honor accent intent (e.g. a highlighted word).
- Do NOT use banned default fonts (Inter, Roboto, Outfit, Poppins, Syne, etc. — see the
  typography reference). Use extreme weight contrast (300 vs 900).

SIZING (for rendered video):
- Headlines 60px+, body text 20px+, data labels 16px+.

DETERMINISM:
- No Math.random(), no Date.now(), no repeat:-1. Construct the timeline synchronously.

When the composition is complete, stop. The system will validate it (lint, contrast,
and layout inspect) and send you any errors to fix.`;
```

- [ ] **Step 5: Run the full compose-handler suite to verify it passes and nothing regressed**

Run: `npx vitest run apps/server/test/pi-compose-handler.test.ts`
Expected: PASS — all existing cases plus the new `read_reference` case. (The existing tests use a faux model that goes straight to `write_composition_file`; registering an extra tool does not change that path.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/phases/pi-compose-handler.ts apps/server/test/pi-compose-handler.test.ts
git commit -m "feat(server): wire read_reference + tighten compose prompt (transitions, fonts, layout)"
```

---

### Task 5: Full-suite regression + e2e sanity

**Files:**
- No new files. Verification only. (The existing `apps/server/test/pipeline-e2e.test.ts` exercises compose through to mp4 with a faux model; confirm it still passes with the new tool registered and `inspect` in the runner — it injects its own `qualityRunner`/`composeHandlerOverride`, so it should be unaffected.)

- [ ] **Step 1: Run the entire server suite**

Run: `npx vitest run apps/server`
Expected: PASS — all suites green (the prior baseline was 213 passing, 1 skipped; this plan adds the `compose-knowledge`, `reference-tool` files and new cases, so the count increases).

- [ ] **Step 2: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the web suite (unaffected, sanity only)**

Run: `npx vitest run apps/web`
Expected: PASS (75 tests, unchanged by this plan).

- [ ] **Step 4: No commit needed** (verification task). If any regression surfaced, fix it under the owning task and re-run.

---

## Notes for the implementer

- **Why `import.meta.url` for the knowledge dir:** the server runs via `tsx` from the repo root, so a path relative to `process.cwd()` would be wrong, and there is no build step copying assets. Resolving relative to the module keeps it correct in dev, test, and `npm start`.
- **`inspect` runtime:** it launches headless Chrome (like `validate`, which already screenshots) and is bounded by the existing `HyperframesQualityRunner` 2-minute timeout. No change to timeout needed.
- **`inspect` false positives:** intentional entrance/exit overflow can be marked in the HTML with `data-layout-allow-overflow`; the agent receives inspect diagnostics in the existing fix loop and can address or mark them.
- **Out of scope (per spec):** `animation-map` (skill script, not a CLI command — not portable) and vision-model visual critique. Do not add them here.
```

