import { copyFile, mkdir, readdir, readFile, rename } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, isAbsolute, join, normalize, relative } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type {
  Brief, Design, LineageRef, NarrationData, PhaseId, Script, ServerEvent,
} from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import { probeImageDimensions, type ImageDimensions } from "./asset-dimensions.js";
import { PiAgentFactory } from "./pi-agent-factory.js";
import { buildNarrationPromptBlock, retimeScenesToNarration } from "./narration-prompt.js";
import { runHarnessToCompletion, type TransientAgentRetryOptions } from "./pi-handler-helpers.js";
import { makeWriteCompositionFileTool } from "../tools/composition-tools.js";
import { makeReadSkillFileTool } from "../tools/read-skill-file-tool.js";
import { makeAddRegistryItemTool } from "../tools/add-registry-item-tool.js";
import { makeGenerateImageTool } from "../tools/image-tools.js";
import { makeGenerateMusicTool } from "../tools/music-tools.js";
import { makeAddSoundEffectTool, formatSoundEffectsForPrompt } from "../tools/sfx-tools.js";
import { isLowContentImage } from "../tools/image-content.js";
import type { ImageProvider, MusicProvider } from "../providers/types.js";
import { loadComposeSkills, SKILLS_BASE_DIR } from "../skills/skill-loader.js";
import { loadRegistryCatalog } from "../registry/registry-loader.js";
import {
  formatEffectRecommendationsForPrompt, recommendRegistryEffects,
} from "../registry/effect-router.js";
import { findRegistryCustomizationViolations } from "../registry/registry-customization-check.js";
import { RESOLUTIONS } from "../render/composition-util.js";
import {
  HyperframesQualityRunner, type QualityRunner,
} from "../render/quality-runner.js";
import { findDesignFidelityViolations } from "../render/design-fidelity-check.js";
import { COMMERCIAL_ICONOGRAPHY_PROMPT } from "../render/iconography-check.js";
import { findProductionPlanComplianceViolations } from "../render/production-plan-compliance-check.js";
import {
  HyperframesSnapshotRunner, planCriticSamples, type SnapshotRunner,
} from "../render/snapshot-runner.js";
import type { VisualCritic, VisualVerdict } from "../render/visual-critic.js";

/** Pixel-level rendered-frame probe: blank scenes + frozen holds (see render/blank-frame-check.ts). */
export type BlankFrameCheck = (projectDir: string, signal: AbortSignal) => Promise<string[]>;

export const SYSTEM_PROMPT = `You are the COMPOSE phase of a promo-video pipeline. You author a
hyperframes composition: a standalone index.html that renders to an animated, on-brand
video. Follow this contract exactly.

${COMMERCIAL_ICONOGRAPHY_PROMPT}

Write files with the write_composition_file tool. Author index.html (and optional CSS /
sub-composition files). Reference media assets by their bare filename (they sit next to
index.html). Never append a query string or cache-buster to a local asset reference
(write "logo.png", NOT "logo.png?v=2") — local files are served statically and a query
string makes them 404 during validation.

SKILLS (read BEFORE authoring):
- The <available_skills> block below lists the gsap + hyperframes authoring skills. Each
  entry has a name, a description, and a "location" (the path to its SKILL.md).
- Use the read_skill_file tool to read the SKILL.md of every skill relevant to this
  composition, then the specific files it references (references/*, palettes/*,
  transitions/*). At minimum consult the "hyperframes" skill plus the gsap skill(s) you
  need for the motion you intend.
- A SKILL.md's relative references resolve against that skill's own directory; pass the
  resulting absolute path to read_skill_file. Reading a directory lists its entries so you
  can discover what's available.
- read_skill_file only reads vendored skill files; you CANNOT run shell commands.

REGISTRY (optional, prebuilt blocks & components):
- Your DEFAULT is to author scenes yourself with HTML/CSS/SVG/GSAP from the design and
  script. The registry is NOT a substitute for designing the composition — most scenes
  should be original work, not assembled from catalog items.
- Reach for a registry item ONLY when it is something genuinely hard or slow to hand-build
  AND a listed item fits the brief: e.g. realistic device mockups, app/social UI chrome
  (notifications, social cards, posts), polished caption styles, or shader/scene
  transitions. For ordinary layout, typography, charts, and motion, write it yourself.
- BUT when the brief/design names a specific, mature visual style or effect (e.g. "liquid
  glass" / glassmorphism, iOS/macOS-style UI, a shader/aurora background) and the effect route
  block matches it, you SHOULD install that block via add_registry_item rather than
  hand-building a flat CSS approximation — the catalog versions carry effects (WebGPU
  refraction, real frosted glass, shaders) you cannot credibly reproduce by hand. Check
  the <effect_route> shortlist for a name matching the requested style before settling
  for a hand-built look-alike.
- The <effect_route> below is a short list selected for this storyboard. To use one,
  call add_registry_item with its name — it installs the files (including
  binary assets you cannot write yourself) and returns wiring instructions: a
  data-composition-src snippet for a BLOCK, or HTML/CSS/JS to merge for a COMPONENT.
- Read the "hyperframes-registry" skill for wiring rules before using one. Never force an
  item in just to use the catalog, and never let the catalog narrow your visual ideas.

DIRECTOR PLAN (binding creative brief):
- The user-approved script may contain productionPlan. Treat its rhythm, energy curve,
  per-scene world, shot/camera direction, depth layers, choreography, transition choices,
  effect slots and SFX cues as the source of truth.
- Realize the hero frame first, then animate the planned build / breathe / resolve arc.
  A named effect is a storytelling beat, not decoration; omit generic flourishes that
  compete with it.

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
- DECORATIVES LIVE IN A CLIP LAYER: put each scene's decoratives inside ONE full-size
  clip layer (position:absolute; inset: 0; overflow: hidden; z-index:0) instead of
  directly in the scene. A shape hanging past the scene's bottom/right edge (e.g. a
  corner circle at bottom:-100px; right:-100px) otherwise inflates the scene's
  scrollWidth, and the layout inspector fails the scene with a bogus full-frame
  clipped_text error (worst mid scene-transition). Descendant GSAP selectors like
  "#scene_2 .bg-shape" still match inside the layer.

NO EMPTY CONTAINERS (non-negotiable):
- Never render an empty styled box/card/panel — a border alone renders as a black box.
  Every visible container holds an image, icon, text, or graphic. Fill card grids cell
  by cell, or use fewer cells. Never repeat identical same-size cards as a default.
- Image/card cells need a real HEIGHT or they COLLAPSE to 0 and the scene renders BLACK:
  the base .scene rule's align-items:center is inherited by a grid/flex scene and sizes each
  cell to its content, so a cell whose only content is a background-image (a label child is
  position:absolute, adding no height) becomes 0px tall and its image never shows. Set the
  container align-items:stretch AND give cells a definite height (grid-template-rows /
  height / aspect-ratio), or carry the image on a sized <img> or text child.

NO CLIPPED TEXT / FIT THE FRAME (non-negotiable):
- All content must fit inside the video frame (the resolution given above) — nothing may
  overflow the bottom or side edges.
  The layout inspector fails the render on clipped text and on images or other elements
  that overflow the frame or their clipping container, so a headline or logo pushed past
  the frame is a hard error, not a cosmetic issue.
- IMAGES/LOGOS — respect the aspect ratio: the available-assets list gives each file's
  true pixel dimensions (W×H). Setting only height forces width = height × (W/H): a wide
  936×168 lockup at height:400px renders ~2229px wide and hangs off a 1920px frame. Size
  wide images by width with a max-width that fits inside the frame (plus height:auto), and
  never size an image by height alone without checking that the implied width fits.
- Keep a safe margin (≈5%): don't let text or content reach the very edges. Use
  box-sizing:border-box so padding counts inside the height, and never give a text box a
  height that, plus its padding/line-height, exceeds the frame.
- Long text MUST wrap, not overflow: give text a max-width (e.g. 80-90% of frame) and let
  it wrap to multiple lines; if a headline is long, use fewer words or a smaller size
  rather than one giant line that runs off-screen. Don't size a text box to the full frame
  and then stuff more text than fits.
- Mentally check the LONGEST line at your chosen font-size against the frame width, and the
  total stacked height of a scene's content against the frame height, before finalizing.

MOTION (non-negotiable):
- Every visible element animates IN via gsap.from(). Offset the first tween 0.1-0.3s.
- Vary eases (no more than 2 tweens share an ease per scene), durations, and entrance
  directions. Use .out for entrances, .in for exits, .inOut for moves.
- NEVER gsap.from() the opacity/autoAlpha of a scene CONTAINER that starts hidden (base
  CSS opacity:0 / visibility:hidden). from() captures its END value from the element's
  current state, which is 0 — so it animates 0→0 and the whole scene stays BLACK for its
  duration. To reveal a hidden scene: use tl.set("#scene", {autoAlpha:1}) (or
  fromTo("#scene", {autoAlpha:0}, {autoAlpha:1, ...}) with an explicit end). Put opacity
  fades on the scene's CHILDREN (whose base opacity is 1), and transition the container
  itself with transform (x/y/scale) or filter — not a bare opacity from().
- Set the scenes' INITIAL hidden state with an immediate gsap.set(".scene", {autoAlpha:0})
  BEFORE building the timeline — NOT a hide-all tl.set(".scene", {autoAlpha:0}) at timeline
  position 0. A position-0 hide-all collides with the first (and any other t=0) scene's
  reveal set and is silently dropped once the runtime stretches the timeline to the root's
  data-duration, leaving that scene BLACK for its whole on-screen window. Reveal each scene
  at its own data-start (the first scene at 0 via the immediate gsap.set above).
- HOLD-PERIOD AMBIENT MOTION: entrance tweens cover only a scene's first ~1-2s; the rest
  must NOT freeze into a still frame — a frozen scene reads as a broken render, and the
  system's rendered-frame check fails scenes with no visible motion in their second half.
  Give every scene of 5s+ at least one ambient tween spanning its FULL remaining window:
  a slow Ken Burns on the hero image or background (scale 1→1.05 with duration = the
  scene's whole window), drifting decorative shapes, or a slow gradient/glow sweep.
- repeat: -1 fails lint (determinism) — that is NOT a license to drop ambient loops.
  Use a finite repeat sized to the window instead: tl.to("#scene_3 .bg-shape",
  {x: 60, y: -40, duration: 3, ease: "sine.inOut", repeat: 3, yoyo: true}, 16.0)
  covers ~12s. Or one slow tween whose duration is the scene's full window.
- Ambient motion must be VISIBLE in the render: translate decoratives ≥3% of the frame
  or scale imagery ≥4% — a 2px drift on a blurred shape at opacity 0.1 still reads as a
  freeze-frame.
- AMBIENT TARGETS: apply ambient scale/drift to imagery and decoratives that sit
  comfortably INSIDE the frame (hero images, shapes inside their clipped bg layer).
  NEVER scale or translate the scene container or a full-frame content wrapper — a
  100%-size layer scaled 1.05 hangs ~25px past the scene's clip edge and FAILS the
  overflow inspection (do not "fix" that by deleting the ambient motion; retarget it).
  For a deliberate full-bleed Ken Burns (scaling an element that fills the frame), mark
  that element data-layout-allow-overflow — its bleed is intentional and the scene
  clips it.

DYNAMIC TEXT EMPHASIS (creative — always available):
- To punch up a key word or phrase, use animated text-emphasis: word-by-word reveals,
  highlight sweeps, kinetic slams, etc. The registry caption-* COMPONENTS (caption-highlight,
  caption-kinetic-slam, caption-pill-karaoke, caption-neon-glow, …) are the tool for this —
  install via add_registry_item when a moment calls for emphasis.
- This is a stylistic effect for emphasis, NOT a subtitle track. It is independent of the
  subtitles setting: use it for impact regardless of whether subtitles are on, and only on
  the few words that deserve emphasis — never to transcribe the whole narration.

TRANSITIONS (non-negotiable):
- Follow productionPlan's transition edit. Use its ONE primary transition plus 1-2
  accents. A hard cut is allowed only when productionPlan explicitly calls for one; do
  not turn every cut into a dissolve or use a different novelty transition per scene.
- Exit animations are BANNED except on the FINAL scene. The transition IS the exit; the
  outgoing scene must be fully visible when the transition starts.
- COVER THE FULL TRANSITION: the outgoing scene must stay visible behind the incoming
  scene for the WHOLE container transition. Start the incoming scene's clip early (within
  the allowed overlap) and size its container transition to COMPLETE by the time the
  outgoing scene's clip window ends — a transition still mid-flight when the outgoing
  clip disappears exposes the page background as a black band.

BRAND FIDELITY:
- Use the FULL design palette, typography, mood, and motionStyle.
- Treat each scene's "visual" field as a DIRECTIVE to realize with CSS/SVG/GSAP — it is
  NOT literal on-screen text. The on-screen text is the scene's onScreenText field.
- Embed the logo asset. Honor accent intent (e.g. a highlighted word).
- FONTS: pick a distinctive font from the Google Fonts catalog and just write its
  font-family — the compiler auto-embeds supported fonts (no <link>/@import needed). Do
  NOT load fonts via <link> or @import; they are unnecessary and unreliable during render.
  Do NOT use OS/system fonts as your typeface (Trebuchet MS, Arial, Helvetica, Lucida,
  Georgia, Verdana, Tahoma, system-ui, etc.) — these are NOT embedded and fall back to a
  generic font in the rendered video (a generic sans-serif/serif as the LAST fallback in a
  stack is fine). Only a true brand font that is not on Google Fonts needs a local .woff2
  bundled next to index.html plus an @font-face rule with a local src.
- Do NOT use banned default/slop fonts (Inter, Roboto, Outfit, Poppins, Syne, etc. — see
  the typography reference). Use extreme weight contrast (300 vs 900).

SIZING (for rendered video):
- Headlines 60px+, body text 20px+, data labels 16px+.

DETERMINISM:
- No Math.random(), no Date.now(), no repeat:-1. Construct the timeline synchronously.

When the composition is complete, stop. The system will validate it (lint, contrast,
and layout inspect) and send you any errors to fix.`;

const IMAGE_TOOL_PROMPT = `

GENERATE IMAGE (use to satisfy NO EMPTY CONTAINERS):
- generate_image: create an image from a text prompt; it is saved next to index.html and
  returns a bare filename like "<id>.png" you can use immediately in an <img src>.
- When a scene calls for imagery you do not already have in the available assets — product
  shots, comparison/variation grids, textured backgrounds — GENERATE it instead of leaving
  a flat colored placeholder box. For an N-cell comparison grid, generate N distinct images
  (vary the prompt per cell). Prefer real generated imagery over empty styled boxes.`;

/**
 * Subtitles are now produced out-of-band as a separate SRT artifact (see
 * render-handler `maybeEmitSubtitles`), never burned into the composition.
 * Retained as a no-op so the compose system-prompt wiring is unchanged.
 */
export function subtitlesBlockFor(_constraints: { subtitles?: boolean }): string {
  return "";
}

const BGM_INSTRUCTION = `

BACKGROUND MUSIC (required for this composition — the user enabled BGM):
- Use the generate_music tool to create ONE background-music track for the whole video.
  Prompt it to match the design's mood/genre and pass the video's total duration; it saves
  the file next to index.html and returns a bare filename.
- Wire it as a single full-length audio clip: <audio data-track-index="…" data-start="0"
  data-duration="<totalSec>" data-volume="0.18" src="<file>">. Put it on its own audio
  track so it does not collide with the narration clips on track 0.
- Keep it quiet — it sits UNDER the content. With narration, data-volume ~0.12-0.2 so speech
  stays clear; without narration you may go a little louder (~0.3). Generate it once; do not
  add multiple competing music tracks.
- generate_music may return analyzed BPM and exact sync points. Select only the strongest
  moments that support productionPlan (hook, proof, hero reveal, CTA) and align the planned
  visual/SFX accent to those global times. Do not add equalizer graphics or pulse every beat;
  audio supplies timing while the storyboard supplies the visual vocabulary.`;

/**
 * The background-music instruction, gated by the bgm constraint. Returns "" unless the
 * user enabled BGM (constraints.bgm === true). The generate_music tool is only wired in
 * when both bgm is enabled AND a music provider is configured.
 */
export function bgmBlockFor(constraints: { bgm?: boolean }): string {
  return constraints.bgm === true ? BGM_INSTRUCTION : "";
}

export interface AvailableAsset {
  name: string;
  role: string;
  dimensions?: ImageDimensions | null;
}

/**
 * Drop design references to assets that no longer exist. The user curates the
 * brief's source images at review gates, but the design artifact is not
 * rewritten — its keyVisuals/sampleFrames may still point at deleted files. A
 * stale refAssetId in the prompt reads as "embed this file"; the file was
 * never copied next to index.html, and validation bounces the 404. Matching is
 * by basename — assets are copied (and listed) under their bare filename.
 */
export function filterDesignToAvailableAssets(
  design: Design,
  available: readonly AvailableAsset[],
): Design {
  const names = new Set(available.map((a) => a.name));
  const present = (ref: string | undefined): boolean => {
    if (!ref) return true; // prose-only entries stay
    if (/^https?:\/\//.test(ref)) return true; // remote refs are not workspace files
    return names.has(basename(ref));
  };
  return {
    ...design,
    keyVisuals: design.keyVisuals.filter((v) => present(v.refAssetId)),
    sampleFrames: design.sampleFrames.map((f) => {
      if (present(f.thumbnailUrl)) return f;
      const { thumbnailUrl: _dead, ...rest } = f;
      return rest;
    }),
  };
}

/**
 * The authored text files (html/css) of a composition, for the
 * design-fidelity pass. Versioned snapshots (index.v<N>.html) are prior
 * versions, not the current author's work — skip them. (They now live in
 * versions/, outside this dir; the skip is defense-in-depth for legacy
 * files the start-of-run migration could not move.)
 */
async function readCompositionTextFiles(
  dir: string,
): Promise<Array<{ path: string; text: string }>> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: Array<{ path: string; text: string }> = [];
  for (const name of names) {
    if (!/\.(html|css)$/i.test(name)) continue;
    if (/^index\.v\d+\.html$/i.test(name)) continue;
    try {
      files.push({ path: name, text: await readFile(join(dir, name), "utf8") });
    } catch {
      // Unreadable file — the geometry gate already covers hard errors.
    }
  }
  return files;
}

/**
 * One `- name (role, W×Hpx)` line per asset. The authoring LLM cannot see the
 * pixels, so the listed dimensions are its only aspect-ratio signal — without
 * them a wide logo lockup gets sized like a square badge and overflows the
 * frame (session e871ba4d).
 */
export function formatAssetsBlock(assets: readonly AvailableAsset[]): string {
  if (assets.length === 0) return "(none downloaded — render brand marks with CSS/SVG)";
  return assets
    .map((a) => {
      const dims = a.dimensions ? `, ${a.dimensions.width}×${a.dimensions.height}px` : "";
      return `- ${a.name} (${a.role}${dims})`;
    })
    .join("\n");
}

export interface PiComposePhaseHandlerOptions {
  agentFactory: PiAgentFactory;
  model: Model<any>;
  /** When set, the compose agent gets a generate_image tool backed by this provider. */
  imageProvider?: ImageProvider;
  /** When set AND constraints.bgm is on, the compose agent gets a generate_music tool. */
  musicProvider?: MusicProvider;
  /** Default: HyperframesQualityRunner (spawns the real CLI). Tests inject a stub. */
  qualityRunner?: QualityRunner;
  /**
   * Pixel-level rendered-frame checks (blank scenes + static holds) run once
   * after the gate passes. Unset → skipped (unit tests; prod wiring passes
   * render/blank-frame-check's findRenderedFrameIssues, which spawns headless
   * Chrome).
   */
  blankFrameCheck?: BlankFrameCheck;
  /** Multimodal commercial-quality review. Unset keeps offline/tests deterministic. */
  visualCritic?: VisualCritic;
  /** Renderer used to build the visual critic's contact sheet. */
  snapshotRunner?: SnapshotRunner;
  /** Max subjective director revisions after hard validation passes. Default 2. */
  maxVisualRounds?: number;
  /** Max fix rounds after the initial authoring pass. Default 4. */
  maxRounds?: number;
  /**
   * Override the skill directories loaded into the agent. Defaults to the
   * vendored gsap + hyperframes skill trees. Tests pass a small/empty list to
   * keep runs hermetic.
   */
  skillDirs?: readonly string[];
  /** Retry policy for transient network failures talking to the LLM. */
  retry?: TransientAgentRetryOptions;
}

export class PiComposePhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "compose";
  constructor(private opts: PiComposePhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    if (ctx.signal.aborted) throw new Error("Aborted");

    const briefEnv = await ctx.artifacts.get<Brief>(ctx.sessionId, "brief");
    const designEnv = await ctx.artifacts.get<Design>(ctx.sessionId, "design");
    const scriptEnv = await ctx.artifacts.get<Script>(ctx.sessionId, "script");
    if (!briefEnv) throw new Error("compose phase requires a brief artifact, none found");
    if (!designEnv) throw new Error("compose phase requires a design artifact, none found");
    if (!scriptEnv) throw new Error("compose phase requires a script artifact, none found");

    const narrationEnv = await ctx.artifacts.get<NarrationData>(ctx.sessionId, "narration");

    const paths = ctx.workspaces.paths(ctx.sessionId);
    const resolution = RESOLUTIONS[briefEnv.data.constraints.aspectRatio];

    // One-time hygiene for pre-versions-dir sessions: legacy per-version
    // snapshots were written next to index.html, where a second root .html
    // trips the renderer's multiple_root_compositions lint. Sweep them into
    // versions/ before the quality gate ever lints the composition dir.
    try {
      await mkdir(paths.versions, { recursive: true });
      for (const name of await readdir(paths.composition)) {
        if (!/^index\.v\d+\.html$/i.test(name)) continue;
        await rename(join(paths.composition, name), join(paths.versions, name)).catch(() => undefined);
      }
    } catch {
      // Best-effort — a failed migration only leaves the old lint warning.
    }

    const assetRefs = new Set<string>();
    if (briefEnv.data.brandHints.logoFile) assetRefs.add(briefEnv.data.brandHints.logoFile);
    for (const img of briefEnv.data.sourceAssets.images) assetRefs.add(img);

    const availableAssets: AvailableAsset[] = [];
    const copied = new Set<string>();
    for (const rel of assetRefs) {
      // Asset refs are agent-authored; refuse anything that escapes the workspace.
      if (isAbsolute(rel)) continue;
      const src = normalize(join(paths.root, rel));
      const within = relative(paths.root, src);
      if (within.startsWith("..") || isAbsolute(within)) continue;
      const name = basename(rel);
      try {
        const dest = join(paths.composition, name);
        await copyFile(src, dest);
        copied.add(name);
        availableAssets.push({
          name,
          role: rel === briefEnv.data.brandHints.logoFile ? "logo" : "image",
          dimensions: await probeImageDimensions(dest),
        });
      } catch {
        // Best-effort: a missing asset is not fatal.
      }
    }

    // Sweep every remaining file in assets/ into the composition dir. This picks
    // up images produced by the design phase's generate_image tool, which land
    // in assets/ but are not referenced by the brief. Swept files were NOT
    // curated by research, so re-probe: a near-blank flat/gradient image that
    // research deliberately rejected must not resurface as a focal "image".
    let assetFiles: string[] = [];
    try {
      assetFiles = await readdir(paths.assets);
    } catch {
      // No assets dir yet — nothing to sweep.
    }
    for (const name of assetFiles) {
      if (copied.has(name)) continue;
      try {
        const dest = join(paths.composition, name);
        await copyFile(join(paths.assets, name), dest);
        copied.add(name);
        const lowContent = await isLowContentImage(await readFile(dest));
        availableAssets.push({
          name,
          role: lowContent ? "decorative-only (near-blank — never a focal image)" : "image",
          dimensions: await probeImageDimensions(dest),
        });
      } catch {
        // Best-effort: skip anything that isn't a regular file we can copy.
      }
    }

    // Revision run: the previous composition (and the media it generated —
    // compose-time images, music) already sit in the composition dir. Load the
    // current index.html for a targeted edit and list those files as reusable
    // so the agent doesn't regenerate paid media the request didn't touch.
    let existingHtml: string | null = null;
    if (ctx.refinement) {
      try {
        existingHtml = await readFile(join(paths.composition, "index.html"), "utf8");
      } catch {
        // No previous composition (e.g. revise-back before compose ever ran) —
        // author from scratch with the refinement folded in.
      }
      let compEntries: Dirent[] = [];
      try {
        compEntries = await readdir(paths.composition, { withFileTypes: true });
      } catch {
        // No composition dir yet.
      }
      for (const entry of compEntries) {
        if (!entry.isFile()) continue;
        const name = entry.name;
        if (copied.has(name)) continue;
        // Code files aren't assets; narration wavs are already described by
        // the narration block above.
        if (name.endsWith(".html") || name.endsWith(".css")) continue;
        if (/^narration-.*\.wav$/i.test(name)) continue;
        availableAssets.push({
          name,
          role: "existing",
          dimensions: await probeImageDimensions(join(paths.composition, name)),
        });
      }
    }

    let narrationBlock = "";
    let narrationTotalSec: string | null = null;
    if (narrationEnv) {
      const built = buildNarrationPromptBlock(narrationEnv.data);
      narrationBlock = built.block;
      narrationTotalSec = built.totalDurationSec;
      // Per-scene wavs were written into the composition dir by the voiceover phase;
      // no copy is needed here.
    }

    // The narration timeline stretches scenes to audio length; feeding the
    // script's stale planned timings alongside it gives the author two
    // conflicting duration sets, and motion sized to the shorter one freezes
    // before the scene ends (prod session 45a7b61e).
    const scenesForPrompt = narrationEnv
      ? retimeScenesToNarration(scriptEnv.data.scenes, narrationEnv.data)
      : scriptEnv.data.scenes;

    // The filesystem environment loads the vendored skills and serves
    // read_skill_file. The stateful compose agent retains its transcript across
    // author/review/re-author turns within this phase run.
    const env = new NodeExecutionEnv({ cwd: SKILLS_BASE_DIR });
    const { skills, roots } = await loadComposeSkills(
      env,
      this.opts.skillDirs ?? undefined,
    );
    const registryCatalog = await loadRegistryCatalog();

    const tools = [
      makeWriteCompositionFileTool({ sessionId: ctx.sessionId, workspaces: ctx.workspaces }),
      makeReadSkillFileTool({ env, roots }),
      makeAddRegistryItemTool({ sessionId: ctx.sessionId, workspaces: ctx.workspaces }),
      makeAddSoundEffectTool({ sessionId: ctx.sessionId, workspaces: ctx.workspaces }),
      ...(this.opts.imageProvider
        ? [
            makeGenerateImageTool({
              sessionId: ctx.sessionId,
              workspaces: ctx.workspaces,
              provider: this.opts.imageProvider,
              targetDir: "composition" as const,
              // Keep every generated image in the design's shared look.
              styleHint: designEnv.data.imageStyle,
            }),
          ]
        : []),
      ...(this.opts.musicProvider && briefEnv.data.constraints.bgm
        ? [
            makeGenerateMusicTool({
              sessionId: ctx.sessionId,
              workspaces: ctx.workspaces,
              provider: this.opts.musicProvider,
              artifacts: ctx.artifacts,
            }),
          ]
        : []),
    ];
    // System prompt = the authoring contract + the native <available_skills>
    // listing (progressive layer 1) + a storyboard-specific effect shortlist. The model then pulls
    // SKILL.md bodies / references on demand via read_skill_file (layers 2-3) and
    // installs registry items via add_registry_item.
    const effectBlock = formatEffectRecommendationsForPrompt(
      recommendRegistryEffects(registryCatalog, scriptEnv.data, designEnv.data, resolution),
      scriptEnv.data,
    );
    const sfxBlock = await formatSoundEffectsForPrompt();
    const imageBlock = this.opts.imageProvider ? IMAGE_TOOL_PROMPT : "";
    const subtitlesBlock = subtitlesBlockFor(briefEnv.data.constraints);
    // Only surface BGM guidance when a music provider is actually wired in.
    const bgmBlock = this.opts.musicProvider ? bgmBlockFor(briefEnv.data.constraints) : "";
    const harness = this.opts.agentFactory.createHarness({
      systemPrompt: () =>
        `${SYSTEM_PROMPT}${imageBlock}${subtitlesBlock}${bgmBlock}\n\n${formatSkillsForSystemPrompt(skills)}\n\n${effectBlock}\n\n${sfxBlock}`,
      tools,
      model: this.opts.model,
      signal: ctx.signal,
    });

    const assetsBlock = formatAssetsBlock(availableAssets);

    const totalDurationSec = narrationTotalSec ?? String(scriptEnv.data.totalSec);
    // Compose authors against narration-retimed scene windows, so every
    // downstream compliance/review step must judge the same effective edit.
    // Comparing against the pre-TTS script would "repair" correct audio-led
    // timings back to stale values.
    const compositionScript: Script = {
      ...scriptEnv.data,
      totalSec: Number(totalDurationSec),
      scenes: scenesForPrompt,
    };

    // The compose agent used to see only design + scenes; the brief's product
    // story, audience, brand hints, real site copy, and the user's own style
    // words were dropped at this boundary.
    const b = briefEnv.data;
    const briefBlock = [
      `Product: ${b.product.name} — ${b.product.tagline} (${b.product.category}). ${b.product.description}`,
      `Audience: ${b.audience}`,
      `Key messages: ${b.keyMessages.join(" | ")}`,
      `Brand colors (background → foreground → accent): ${b.brandHints.colors.join(", ") || "(none)"}` +
        (b.brandHints.fonts?.length ? `; brand fonts: ${b.brandHints.fonts.join(", ")}` : ""),
      ...(b.sourceAssets.copy.length
        ? [`Source copy (verbatim lines from the site — strong on-screen text candidates):\n${b.sourceAssets.copy.slice(0, 10).map((c) => `  - ${c}`).join("\n")}`]
        : []),
      ...(b.styleIntent ? [`USER STYLE INTENT (honor verbatim): ${b.styleIntent}`] : []),
    ].join("\n");

    const designForPrompt = filterDesignToAvailableAssets(designEnv.data, availableAssets);

    const contextParts = [
      `Resolution: ${resolution.width}x${resolution.height} (aspectRatio ${briefEnv.data.constraints.aspectRatio}).`,
      `Total duration: ${totalDurationSec}s.`,
      `Brief:\n${briefBlock}`,
      `Design: ${JSON.stringify(designForPrompt, null, 2)}`,
      `Script scenes (each "visual" is a directive to realize, NOT literal text): ${JSON.stringify(scenesForPrompt, null, 2)}`,
      `Director production plan (binding creative decisions; scene-local cue times must be converted to global timeline times): ${JSON.stringify(scriptEnv.data.productionPlan ?? null, null, 2)}`,
      `Available asset files (reference by bare filename, next to index.html):\n${assetsBlock}${narrationBlock}`,
    ];
    const prompt = (existingHtml && ctx.refinement
      ? [
          ...contextParts,
          `CURRENT COMPOSITION (composition/index.html) — the video the user is revising:\n\`\`\`html\n${existingHtml}\n\`\`\``,
          `USER REVISION REQUEST: ${ctx.refinement}\n\nMake a TARGETED revision of the current composition that fulfils this request. Keep everything the request doesn't touch — scenes, timings, styles, asset references, audio clips — exactly as-is. Reuse the existing asset files listed above; do NOT regenerate images or music the current composition already uses unless the request asks for new media. Write the full updated index.html via write_composition_file.`,
        ]
      : [
          ...contextParts,
          ...(ctx.refinement
            ? [`USER REVISION REQUEST (apply while authoring): ${ctx.refinement}`]
            : []),
          `Author index.html now via write_composition_file.`,
        ]
    ).join("\n\n");

    yield* runHarnessToCompletion({
      phase: this.phase,
      harness,
      prompt,
      signal: ctx.signal,
      retry: this.opts.retry,
    });

    const runner = this.opts.qualityRunner ?? new HyperframesQualityRunner();
    const maxRounds = this.opts.maxRounds ?? 4;
    let round = 0;
    // The geometry gate can't see brand fidelity; diff the authored files
    // against the design once (a single pass — intentional deviations must
    // not wedge the loop). Same single-pass rule for the pixel-level
    // blank-frame probe.
    let fidelityChecked = false;
    let registryCustomizationChecked = false;
    let productionPlanChecked = false;
    let productionPlanFixes = 0;
    let blankChecked = false;
    let visualReviewComplete = false;
    let visualRounds = 0;
    let latestVisualVerdict: VisualVerdict | undefined;
    const visualReviewHistory: VisualVerdict[] = [];
    let lastCriticSamples: ReturnType<typeof planCriticSamples> = [];
    while (true) {
      if (ctx.signal.aborted) throw new Error("Aborted");
      yield { type: "phase.progress", phase: this.phase, message: "Validating composition" };
      const result = await runner.check(paths.composition, ctx.signal);
      if (result.ok) {
        if (!fidelityChecked) {
          fidelityChecked = true;
          const violations = findDesignFidelityViolations(
            await readCompositionTextFiles(paths.composition),
            designEnv.data,
          );
          // Single-pass fix (bounded by fidelityChecked), so it deliberately
          // does NOT consume the geometry round budget: a geometry-heavy
          // session used to spend its last round here and hard-fail when the
          // fix introduced a fresh layout error with no budget left to
          // correct it (prod session 15796467, frame-check variant).
          if (violations.length > 0) {
            yield {
              type: "phase.progress",
              phase: this.phase,
              message: `Design-fidelity check flagged ${violations.length} issue(s); revising`,
            };
            yield* runHarnessToCompletion({
              phase: this.phase,
              harness,
              prompt:
                `The composition passed layout validation but violates the DESIGN contract. ` +
                `Fix these with write_composition_file (keep everything else as-is):\n` +
                violations.map((v) => `- ${v}`).join("\n"),
              signal: ctx.signal,
              retry: this.opts.retry,
            });
            continue;
          }
        }
        if (!registryCustomizationChecked) {
          registryCustomizationChecked = true;
          const violations = await findRegistryCustomizationViolations(
            paths.composition,
            designEnv.data,
          );
          if (violations.length > 0) {
            yield {
              type: "phase.progress",
              phase: this.phase,
              message: `Registry customization check flagged ${violations.length} issue(s); revising`,
            };
            yield* runHarnessToCompletion({
              phase: this.phase,
              harness,
              prompt:
                `The composition uses registry blocks but still exposes catalog branding, stock ` +
                `copy, or default colors. Customize the installed blocks before shipping. Use ` +
                `add_registry_item with values/textReplacements when directed, preserve the ` +
                `existing host timing, then keep all other composition behavior unchanged:\n` +
                violations.map((violation) => `- ${violation}`).join("\n"),
              signal: ctx.signal,
              retry: this.opts.retry,
            });
            fidelityChecked = false;
            continue;
          }
        }
        if (!productionPlanChecked) {
          productionPlanChecked = true;
          const violations = await findProductionPlanComplianceViolations(
            paths.composition,
            compositionScript,
          );
          if (violations.length > 0) {
            if (productionPlanFixes >= 2) {
              const error =
                `Composition still violates the approved director plan after 2 repairs:\n` +
                violations.map((violation) => `- ${violation}`).join("\n");
              yield { type: "phase.error", phase: this.phase, error };
              throw new Error(error);
            }
            productionPlanFixes++;
            yield {
              type: "phase.progress",
              phase: this.phase,
              message: `Director-plan compliance check flagged ${violations.length} issue(s); revising`,
            };
            yield* runHarnessToCompletion({
              phase: this.phase,
              harness,
              prompt:
                `The composition is technically valid but does not faithfully implement the ` +
                `approved director plan. Fix only these scene-window / production-audio wiring ` +
                `issues, using add_sound_effect when requested, and preserve all approved ` +
                `creative work:\n` + violations.map((violation) => `- ${violation}`).join("\n"),
              signal: ctx.signal,
              retry: this.opts.retry,
            });
            fidelityChecked = false;
            registryCustomizationChecked = false;
            productionPlanChecked = false;
            continue;
          }
        }
        if (!blankChecked && this.opts.blankFrameCheck) {
          blankChecked = true;
          yield { type: "phase.progress", phase: this.phase, message: "Checking rendered frames for blank or frozen scenes" };
          const blanks = await this.opts.blankFrameCheck(paths.composition, ctx.signal);
          // Same single-pass/no-budget rule as the fidelity fix above.
          if (blanks.length > 0) {
            yield {
              type: "phase.progress",
              phase: this.phase,
              message: `Rendered-frame check flagged ${blanks.length} issue(s); revising`,
            };
            yield* runHarnessToCompletion({
              phase: this.phase,
              harness,
              prompt:
                `Rendered-frame inspection found scenes that display as BLACK or freeze into a ` +
                `static hold — the worst defects a video can ship. Fix them with write_composition_file:\n` +
                blanks.map((v) => `- ${v}`).join("\n"),
              signal: ctx.signal,
              retry: this.opts.retry,
            });
            continue;
          }
        }
        if (!visualReviewComplete && this.opts.visualCritic) {
          yield {
            type: "phase.progress",
            phase: this.phase,
            message: "Reviewing commercial art direction across rendered frames",
          };
          try {
            const snapshotRunner = this.opts.snapshotRunner ?? new HyperframesSnapshotRunner();
            lastCriticSamples = planCriticSamples(scenesForPrompt, {
              productionPlan: scriptEnv.data.productionPlan,
            });
            const frames = await snapshotRunner.capture(
              paths.composition,
              lastCriticSamples,
              ctx.signal,
            );
            if (frames.length === 0) {
              visualReviewComplete = true; // best-effort: snapshot tooling unavailable
            } else {
              const verdict = await this.opts.visualCritic.critique({
                frames,
                script: compositionScript,
                design: designEnv.data,
                signal: ctx.signal,
              });
              latestVisualVerdict = verdict;
              visualReviewHistory.push(verdict);
              const maxVisualRounds = this.opts.maxVisualRounds ?? 2;
              if (!verdict.ok && visualRounds < maxVisualRounds && verdict.issues.length > 0) {
                visualRounds++;
                const prioritizedIssues = [...verdict.issues]
                  .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1))
                  .slice(0, 4);
                yield {
                  type: "phase.progress",
                  phase: this.phase,
                  message:
                    `Creative-director review scored ${Math.round(verdict.score)}/100; ` +
                    `revising ${verdict.issues.length} issue(s)`,
                };
                yield* runHarnessToCompletion({
                  phase: this.phase,
                  harness,
                  prompt:
                    `A multimodal creative-director review found the composition technically ` +
                    `valid but below a commercial promo bar (${verdict.score}/100). Make a focused ` +
                    `art-direction revision with write_composition_file. Preserve correct timings, ` +
                    `assets, audio, and brand facts. Do not merely add more effects; solve the named ` +
                    `hierarchy/composition/choreography problems. Change only the named scenes so ` +
                    `already-successful beats do not regress. Score history: ` +
                    `${visualReviewHistory.map((review) => Math.round(review.score)).join(" → ")}.\n\n` +
                    `Summary: ${verdict.summary}\n` + prioritizedIssues.map((issue) =>
                      `- [${issue.severity}] scene ${issue.sceneId} / ${issue.category}: ` +
                      `${issue.note} FIX: ${issue.fix}`,
                    ).join("\n"),
                  signal: ctx.signal,
                  retry: this.opts.retry,
                });
                // Any creative rewrite must re-pass every objective gate before
                // it can ship, then gets one final director look.
                fidelityChecked = false;
                registryCustomizationChecked = false;
                productionPlanChecked = false;
                productionPlanFixes = 0;
                blankChecked = false;
                continue;
              }
              visualReviewComplete = true;
              yield {
                type: "phase.progress",
                phase: this.phase,
                message: verdict.ok
                  ? `Commercial quality review passed (${Math.round(verdict.score)}/100)`
                  : `Commercial quality review completed at ${Math.round(verdict.score)}/100 ` +
                    `with ${verdict.issues.length} remaining issue(s)`,
              };
            }
          } catch (error) {
            if (ctx.signal.aborted) throw error;
            // Subjective review is a quality net, never a new availability risk.
            visualReviewComplete = true;
            yield {
              type: "phase.progress",
              phase: this.phase,
              message: "Creative-director review unavailable; continuing after hard validation",
            };
          }
        }
        break;
      }
      if (ctx.signal.aborted) throw new Error("Aborted");
      round++;
      if (round > maxRounds) {
        const error = `Composition failed validation after ${maxRounds} rounds:\n${result.diagnostics}`;
        yield { type: "phase.error", phase: this.phase, error };
        throw new Error(error);
      }
      yield {
        type: "phase.progress",
        phase: this.phase,
        message: `Composition validation failed (round ${round}); re-authoring`,
      };
      yield* runHarnessToCompletion({
        phase: this.phase,
        harness,
        prompt: `The composition failed validation. Fix the files using write_composition_file.\n\nDiagnostics:\n${result.diagnostics}`,
        signal: ctx.signal,
        retry: this.opts.retry,
      });
    }

    const lineage: LineageRef[] = [
      { kind: "design", version: designEnv.version },
      { kind: "script", version: scriptEnv.version },
    ];
    if (narrationEnv) lineage.push({ kind: "narration", version: narrationEnv.version });
    const compEnv = await ctx.artifacts.put(
      ctx.sessionId,
      "composition",
      {
        dir: "composition",
        entry: "index.html",
        ...(latestVisualVerdict
          ? {
              quality: {
                commercialScore: latestVisualVerdict.score,
                summary: latestVisualVerdict.summary,
                passed: latestVisualVerdict.ok,
                remainingIssues: latestVisualVerdict.issues,
                reviewCount: visualReviewHistory.length,
                scoreHistory: visualReviewHistory.map((review) => review.score),
                sampledFrames: lastCriticSamples,
              },
            }
          : {}),
      },
      { derivedFrom: lineage },
    );
    // Per-version snapshot (versions/index.v<N>.html): compose overwrites
    // index.html in place on every run, so without this an older video version
    // could never be restored as the base for further adjustments. Lives
    // outside composition/ (see WorkspacePaths.versions). Best-effort — a lost
    // snapshot only degrades restore to mp4-only.
    await mkdir(paths.versions, { recursive: true }).catch(() => undefined);
    await copyFile(
      join(paths.composition, "index.html"),
      join(paths.versions, `index.v${compEnv.version}.html`),
    ).catch(() => undefined);
  }
}
