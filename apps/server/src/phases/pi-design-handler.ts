import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { Brief, LineageRef, PhaseId, ServerEvent } from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import { PiAgentFactory } from "./pi-agent-factory.js";
import { runAgentForArtifact, type TransientAgentRetryOptions } from "./pi-handler-helpers.js";
import { makeWriteDesignTool } from "../tools/artifact-write-tools.js";
import { makeGenerateImageTool } from "../tools/image-tools.js";
import { imageContentFromFile } from "../tools/image-content.js";
import type { ImageProvider } from "../providers/types.js";
import { COMMERCIAL_ICONOGRAPHY_PROMPT } from "../render/iconography-check.js";

/**
 * Craft rules distilled from the vendored hyperframes design system
 * (house-style.md, references/typography.md, palettes/*) — the design phase is
 * a bare Agent with no skill access, so the knowledge has to live here.
 */
const BASE_SYSTEM_PROMPT = `You are the DESIGN phase of a promo-video pipeline — the art director.
You receive a structured brief (and often screenshots of the source website and its
logo as images). Produce the design board every later phase must obey: palette with
roles, typography, motion language, key visuals, and 2-4 sample frame ideas. Be
opinionated and concrete; vague direction produces generic video.

${COMMERCIAL_ICONOGRAPHY_PROMPT}

PROCESS:
1. Study the brief AND every attached image. The screenshots are the brand's actual
   look — your palette must feel like it belongs to that brand.
2. Internally sketch 3 genuinely different directions (e.g. one faithful-to-brand,
   one bolder editorial take, one high-energy). Pick the strongest for THIS product
   and audience; fold in the best details from the discarded two.
3. Fill every field of write_design, including colorRoles, typeScale, motion and
   imageStyle.

COLOR (colorRoles is the contract — the composer builds from it):
- Declare ONE background, ONE foreground, ONE accent (plus optional surface).
  brandHints.colors arrive ordered background → foreground → accent; respect them
  unless the attached imagery clearly disagrees.
- Light vs dark by content: food/wellness/kids → light; tech/cinema/finance → dark.
- One accent hue only. Tint neutrals toward the accent (never dead gray, never pure
  #000/#fff — tint toward your hue).
- Foreground-on-background contrast MUST be ≥ 4.5:1 (display text ≥ 3:1). The system
  hard-fails renders on WCAG contrast, so a muddy pair costs a whole revision round.
- Palette = 3-6 named hexes. Every hex the composer may use goes here; it must not
  invent colors later.

TYPOGRAPHY:
- Fonts MUST be Google-Fonts-hosted families (the renderer can only embed those). A
  brand font that isn't on Google Fonts → pick the closest Google match and note it.
- NEVER use these overused defaults: Inter, Roboto, Open Sans, Noto Sans, Arimo,
  Lato, Source Sans, PT Sans, Nunito, Poppins, Outfit, Sora, Playfair Display,
  Cormorant Garamond, Bodoni Moda, EB Garamond, Cinzel, Prata, Syne.
- Pair a distinctive display face with a quiet text face (serif + sans beats two
  sans). Use extreme weight contrast: 700-900 headlines, 300-400 body.
- typeScale is VIDEO scale: display ≥ 90px, headings ≥ 60px, body ≥ 20px.

MOTION:
- motion.energy matches the brief's tone (calm / confident / energetic / frenetic).
- motion.easing names a GSAP ease family (e.g. "power3.out entrances, expo.out for
  the hero, sine.inOut ambient drift").
- 2-3 principles the composer must keep (e.g. "entrances overlap, never sequential",
  "one slow ambient motion per scene background", "exits only on the final scene").

IMAGERY:
- imageStyle: ONE reusable style suffix that will be appended to every generated
  image prompt (medium + palette words + lighting, e.g. "flat vector illustration,
  deep navy background, coral accent, soft rim light"). This keeps all AI imagery in
  the video visually consistent.
- keyVisuals: name the 3-5 visuals the video needs, referencing real captured assets
  (refAssetId) whenever one fits — real product imagery beats generated imagery.

Tools:
- write_design: persist the final design. Call this EXACTLY ONCE when ready.`;

const IMAGE_TOOL_PROMPT = `
- generate_image: create an image from a text prompt; it is saved into the session
  and returns a path like "assets/<id>.png". Use it to produce key visuals the video
  will need but does not already have — hero shots, comparison variations, textured
  backgrounds. Append your imageStyle suffix to EVERY prompt so generated imagery
  stays consistent. If a sample frame calls for N image variations, generate N
  distinct images rather than leaving empty placeholders. Reference the returned
  paths in the design's keyVisuals / sampleFrames so later phases can use them.`;

const PROMPT_TAIL = `

Rules:
- Use the brief.constraints.aspectRatio and brief.brandHints.colors as starting points.
- Honor brief.styleIntent verbatim when present — it is the user's own words.
- If a refinement note is provided, honor it; otherwise design from scratch.
- Call write_design with the complete design object when finished. Do not call it more than once.

CRITICAL: You are NOT done until you call write_design. Never end your turn with only a
prose summary — the design is only saved when you emit the write_design tool call.`;

/** Max images attached to the design prompt (logo + site screenshots). */
const MAX_DESIGN_IMAGES = 3;

export interface PiDesignPhaseHandlerOptions {
  agentFactory: PiAgentFactory;
  model: Model<any>;
  /** When set, the design agent gets a generate_image tool backed by this provider. */
  imageProvider?: ImageProvider;
  /** Retry policy for transient network failures talking to the LLM. */
  retry?: TransientAgentRetryOptions;
}

export class PiDesignPhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "design";
  constructor(private opts: PiDesignPhaseHandlerOptions) {}

  /**
   * Visual grounding for the art director: the brand logo plus the site
   * screenshots the research capture took. Best-effort — a design without
   * images is degraded, not broken.
   */
  private async collectImages(ctx: PhaseContext, brief: Brief): Promise<ImageContent[]> {
    const root = ctx.workspaces.paths(ctx.sessionId).root;
    const images: ImageContent[] = [];

    if (brief.brandHints.logoFile) {
      const block = await imageContentFromFile(join(root, brief.brandHints.logoFile), { maxDim: 768 });
      if (block) images.push(block);
    }

    try {
      const shotDir = join(root, "capture", "screenshots");
      const shots = (await readdir(shotDir))
        .filter((f) => !f.startsWith("contact-sheet"))
        .sort();
      for (const shot of shots) {
        if (images.length >= MAX_DESIGN_IMAGES) break;
        const block = await imageContentFromFile(join(shotDir, shot), { maxDim: 1280 });
        if (block) images.push(block);
      }
    } catch {
      // No capture ran for this session.
    }
    return images;
  }

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    const briefEnv = await ctx.artifacts.get<Brief>(ctx.sessionId, "brief");
    if (!briefEnv) {
      throw new Error("design phase requires a brief artifact, none found");
    }

    const prevDesignEnv = await ctx.artifacts.get(ctx.sessionId, "design");
    const derivedFrom: LineageRef[] = prevDesignEnv
      ? [
          { kind: "design", version: prevDesignEnv.version },
          { kind: "brief", version: briefEnv.version },
        ]
      : [{ kind: "brief", version: briefEnv.version }];

    const tools = [
      makeWriteDesignTool({
        sessionId: ctx.sessionId,
        artifacts: ctx.artifacts,
        derivedFrom,
      }),
      ...(this.opts.imageProvider
        ? [
            makeGenerateImageTool({
              sessionId: ctx.sessionId,
              workspaces: ctx.workspaces,
              provider: this.opts.imageProvider,
              targetDir: "assets" as const,
            }),
          ]
        : []),
    ];

    const systemPrompt =
      BASE_SYSTEM_PROMPT + (this.opts.imageProvider ? IMAGE_TOOL_PROMPT : "") + PROMPT_TAIL;

    const agent = this.opts.agentFactory.create({
      systemPrompt,
      tools,
      model: this.opts.model,
      signal: ctx.signal,
    });

    const images = await this.collectImages(ctx, briefEnv.data);

    const promptParts: string[] = [
      `Brief: ${JSON.stringify(briefEnv.data, null, 2)}`,
    ];
    if (images.length > 0) {
      promptParts.push(
        `Attached: ${images.length} image(s) — the brand logo and/or screenshots of the source website. Ground the palette and art direction in what they actually look like.`,
      );
    }
    if (prevDesignEnv) {
      promptParts.push(`Previous design: ${JSON.stringify(prevDesignEnv.data, null, 2)}`);
    }
    if (ctx.refinement) {
      promptParts.push(`Refinement: ${ctx.refinement}`);
    }

    yield* runAgentForArtifact({
      phase: this.phase,
      agent,
      prompt: promptParts.join("\n\n"),
      images,
      artifacts: ctx.artifacts,
      sessionId: ctx.sessionId,
      kind: "design",
      toolName: "write_design",
      signal: ctx.signal,
      retry: this.opts.retry,
    });
  }
}
