import type { Model } from "@earendil-works/pi-ai";
import type { PhaseId, ServerEvent, UserMessage } from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import { PiAgentFactory } from "./pi-agent-factory.js";
import { runAgentForArtifact, type TransientAgentRetryOptions } from "./pi-handler-helpers.js";
import {
  makeWebFetchTool,
  makeReadUploadTool,
  makeDownloadAssetTool,
  type WebFetchToolOptions,
  type DownloadAssetToolOptions,
} from "../tools/research-tools.js";
import { makeCaptureWebsiteTool, type CaptureWebsiteToolOptions } from "../tools/capture-tools.js";
import { makeWriteBriefTool } from "../tools/artifact-write-tools.js";

const SYSTEM_PROMPT = `You are the RESEARCH phase of a promo-video pipeline.

Your job: given a user's product description (which may include a URL and uploaded
files), produce a structured brief that captures the product, its audience, key
selling points, brand cues, and any source assets you saw. Everything downstream —
the palette, the typography, the imagery — is built on what you extract here, so
ground every brand claim in something you actually SAW.

Available tools:
- capture_website: capture a URL with a headless browser. Returns extracted design
  tokens (the site's real colors ordered by usage, real fonts), page copy, a list of
  downloaded asset files under capture/assets/, and SCREENSHOTS you can see. ALWAYS
  use this FIRST when the user provides a URL.
- web_fetch: fetch a URL's raw text/HTML. Fallback when capture fails; also useful
  for secondary pages (pricing, docs, about).
- download_asset: download an image by URL into this session's assets/ dir. Returns
  a local relative path like "assets/<hash>.png", shows you the image, and names its
  dominant colors.
- read_upload: read a file the user uploaded to this session (images are shown to you).
- write_brief: persist the final brief. Call this EXACTLY ONCE when ready.

BRAND EXTRACTION (brandHints):
- colors: 3-6 hex values, ORDERED background first, then foreground, then accent(s).
  Source priority: capture_website design tokens (cross-check against the screenshots)
  → dominant colors reported for the downloaded logo / og:image → theme-color meta or
  :root CSS custom properties in fetched HTML. Only invent colors when the source
  truly has none.
- fonts: the site's REAL font families (from capture tokens or CSS font-family
  stacks) — downstream picks the closest Google-Fonts match, so exact names matter.
- logo: prefer an SVG or the highest-resolution logo asset you saw. Put its local
  path in brandHints.logoFile, the original URL in brandHints.logoUrl.

ASSETS (sourceAssets):
- images: real product/content imagery ONLY (screenshots, product UI, mascots,
  photos). LOOK at each image you collected — exclude decorative gradients, banners,
  spacers, and anything flagged near-blank (these become scene focal images
  downstream, and a blank one renders as an empty coloured box). Local paths only
  ("assets/..." or "capture/assets/..."), never remote URLs.
- Prefer the highest-resolution variant (largest srcset candidate, og:image).
- Logo plus up to ~5 key images. Downloads are best-effort: if one fails, continue.
- copy: put the site's strongest short lines (taglines, value props, stats) into
  sourceAssets.copy VERBATIM — the composer uses them as on-screen text candidates.

STYLE INTENT:
- If the user expresses ANY aesthetic/style wish ("minimal", "high-end", "playful",
  "like an Apple ad"), copy it into styleIntent verbatim. Leave it unset otherwise.

Rules:
- The user's message may contain @label mentions (e.g. @logo, @image1) that refer to
  the "Referenced assets" listed beneath it. Treat the asset labelled "logo" as the
  brand logo; use read_upload to inspect any referenced asset by its path.
- Keep keyMessages to at most 3 items.
- Pass through the durationSec / aspectRatio / withVoiceover / subtitles / bgm constraints
  from the user message verbatim (include subtitles / bgm only if present in the user message).
- Call write_brief with the complete brief object when finished. Do not call it more than once.

CRITICAL: You are NOT done until you call write_brief. Never end your turn with only a
prose summary — the brief is only saved when you emit the write_brief tool call.`;

export function buildResearchPrompt(
  initial: UserMessage | undefined,
  refinement: string | undefined,
): string {
  const promptParts: string[] = [];
  if (initial) {
    promptParts.push(`User message: ${initial.text}`);
    if (initial.assets?.length) {
      const lines = initial.assets.map(
        (a) => `- @${a.label} → ${a.path}${a.role === "logo" ? " (the brand LOGO)" : ""}`,
      );
      promptParts.push(
        `Referenced assets (the user may cite these as @label in their message):\n${lines.join("\n")}`,
      );
    } else if (initial.uploadedFiles?.length) {
      // Labeled `assets` take precedence; `uploadedFiles` is the legacy flat-list path.
      promptParts.push(`Uploaded files: ${initial.uploadedFiles.join(", ")}`);
    }
    if (initial.constraints) {
      promptParts.push(`Constraints: ${JSON.stringify(initial.constraints)}`);
    }
  }
  if (refinement) {
    promptParts.push(`Refinement: ${refinement}`);
  }
  return promptParts.join("\n\n") || "Begin research.";
}

export interface PiResearchPhaseHandlerOptions {
  agentFactory: PiAgentFactory;
  model: Model<any>;
  fetch: WebFetchToolOptions["fetch"];
  fetchBinary: DownloadAssetToolOptions["fetchBinary"];
  /** Override the spawned capture argv (tests). */
  captureCommandFor?: CaptureWebsiteToolOptions["commandFor"];
  /** Retry policy for transient network failures talking to the LLM. */
  retry?: TransientAgentRetryOptions;
}

export class PiResearchPhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "research";
  constructor(private opts: PiResearchPhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    const tools = [
      makeCaptureWebsiteTool({
        sessionId: ctx.sessionId,
        workspaces: ctx.workspaces,
        commandFor: this.opts.captureCommandFor,
      }),
      makeWebFetchTool({ fetch: this.opts.fetch }),
      makeDownloadAssetTool({
        sessionId: ctx.sessionId,
        workspaces: ctx.workspaces,
        fetchBinary: this.opts.fetchBinary,
      }),
      makeReadUploadTool({ sessionId: ctx.sessionId, workspaces: ctx.workspaces }),
      makeWriteBriefTool({
        sessionId: ctx.sessionId,
        artifacts: ctx.artifacts,
        // User's UI constraints (voice, duration, toggles) are authoritative;
        // stamp them onto the brief rather than relying on LLM pass-through.
        userConstraints: ctx.initialMessage?.constraints,
      }),
    ];

    const agent = this.opts.agentFactory.create({
      systemPrompt: SYSTEM_PROMPT,
      tools,
      model: this.opts.model,
      signal: ctx.signal,
    });

    const prompt = buildResearchPrompt(ctx.initialMessage, ctx.refinement);

    yield* runAgentForArtifact({
      phase: this.phase,
      agent,
      prompt,
      artifacts: ctx.artifacts,
      sessionId: ctx.sessionId,
      kind: "brief",
      toolName: "write_brief",
      signal: ctx.signal,
      retry: this.opts.retry,
    });
  }
}
