import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { ImageProvider } from "../providers/types.js";
import { withTransientRetry } from "../retry.js";

/**
 * Where the generated file is written, and how its reference is returned:
 * - "assets": writes to assets/, returns "assets/<hash>.png" (design phase — the
 *   compose phase later sweeps assets/ into composition/).
 * - "composition": writes directly next to index.html, returns a bare
 *   "<hash>.png" the compose agent can reference immediately (the pre-run asset
 *   copy has already happened, so a mid-run image must land in composition/).
 */
export type ImageTargetDir = "assets" | "composition";

export interface GenerateImageToolOptions {
  sessionId: string;
  workspaces: WorkspaceManager;
  provider: ImageProvider;
  targetDir: ImageTargetDir;
  /**
   * The design's shared image style (medium, palette words, lighting).
   * Appended to every prompt so all generated imagery in one video shares a
   * look instead of drifting per call.
   */
  styleHint?: string;
  /** Retry policy for transient provider failures (network blips, 429/5xx). */
  retry?: { attempts?: number; baseDelayMs?: number };
}

const generateImageParameters = Type.Object({
  prompt: Type.String({
    description: "Detailed text-to-image prompt describing the image to create.",
  }),
  aspectRatio: Type.Optional(
    Type.String({ description: 'Optional aspect ratio, e.g. "16:9", "1:1", "9:16".' }),
  ),
});

export function makeGenerateImageTool(
  opts: GenerateImageToolOptions,
): AgentTool<typeof generateImageParameters> {
  return {
    name: "generate_image",
    label: "Generate Image",
    description:
      "Generate an image from a text prompt and save it into the session. Returns the " +
      "path/filename to reference. Use this when a scene needs an image you do not already " +
      "have (product shots, comparison variations, backgrounds) instead of leaving an empty placeholder.",
    parameters: generateImageParameters,
    execute: async (_callId, params, signal) => {
      let prompt = params.prompt?.trim();
      if (!prompt) {
        throw new Error("generate_image requires a non-empty prompt");
      }
      const styleHint = opts.styleHint?.trim();
      if (styleHint && !prompt.toLowerCase().includes(styleHint.toLowerCase())) {
        prompt = `${prompt}. Style: ${styleHint}`;
      }

      // Unique per call so repeated identical prompts (e.g. 4 comparison
      // variations) never collide. The provider's output is non-deterministic
      // anyway, so a content hash is not meaningful here.
      const hash = randomBytes(8).toString("hex");
      const fileName = `${hash}.png`;
      const dir = opts.workspaces.paths(opts.sessionId)[opts.targetDir];
      const abs = join(dir, fileName);

      const result = await withTransientRetry(
        () =>
          opts.provider.generate({
            prompt,
            aspectRatio: params.aspectRatio,
            outputPath: abs,
            signal,
          }),
        { ...opts.retry, signal },
      );

      const ref = opts.targetDir === "assets" ? `assets/${fileName}` : fileName;
      return {
        content: [{ type: "text", text: ref }],
        details: {
          prompt,
          aspectRatio: params.aspectRatio,
          path: ref,
          mimeType: result.mimeType,
        },
      };
    },
  };
}
