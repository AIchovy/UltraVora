import { randomBytes } from "node:crypto";
import { join, parse } from "node:path";
import { writeFile } from "node:fs/promises";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { MusicProvider } from "../providers/types.js";
import { withTransientRetry } from "../retry.js";
import { FfmpegAudioAnalyzer, type AudioAnalyzer } from "../audio/audio-analysis.js";

export interface GenerateMusicToolOptions {
  sessionId: string;
  workspaces: WorkspaceManager;
  provider: MusicProvider;
  /** Records the generated track as a `music` artifact so the UI can find it. */
  artifacts: ArtifactStore;
  /** Retry policy for transient provider failures (network blips, 429/5xx). */
  retry?: { attempts?: number; baseDelayMs?: number };
  /** Override/disable for tests. Default: best-effort ffmpeg onset analysis. */
  audioAnalyzer?: AudioAnalyzer | null;
}

const generateMusicParameters = Type.Object({
  prompt: Type.String({
    description: "Describe the background music: mood, genre, tempo, instrumentation.",
  }),
  durationSec: Type.Number({
    description: "Target length in seconds (use the video's total duration).",
  }),
});

export function makeGenerateMusicTool(
  opts: GenerateMusicToolOptions,
): AgentTool<typeof generateMusicParameters> {
  return {
    name: "generate_music",
    label: "Generate Music",
    description:
      "Generate one background-music track from a text prompt and save it next to index.html. " +
      "Returns the bare filename to reference in a full-duration <audio> clip (mix it under the " +
      "narration at low volume).",
    parameters: generateMusicParameters,
    execute: async (_callId, params, signal) => {
      const prompt = params.prompt?.trim();
      if (!prompt) {
        throw new Error("generate_music requires a non-empty prompt");
      }
      const durationSec = params.durationSec > 0 ? params.durationSec : 30;

      const fileName = `${randomBytes(8).toString("hex")}.wav`;
      const abs = join(opts.workspaces.paths(opts.sessionId).composition, fileName);

      const result = await withTransientRetry(
        () => opts.provider.generate({ prompt, durationSec, outputPath: abs, signal }),
        { ...opts.retry, signal },
      );

      let analysis = null;
      try {
        analysis = await (opts.audioAnalyzer === undefined
          ? new FfmpegAudioAnalyzer()
          : opts.audioAnalyzer)?.analyze(abs, signal) ?? null;
      } catch {
        // Beat analysis improves direction but must never discard a paid track.
      }
      const analysisFile = analysis ? `${parse(fileName).name}.analysis.json` : undefined;
      if (analysis && analysisFile) {
        await writeFile(join(opts.workspaces.paths(opts.sessionId).composition, analysisFile), JSON.stringify(analysis), "utf8");
      }

      await opts.artifacts.put(opts.sessionId, "music", {
        file: fileName,
        prompt,
        durationSec,
        ...(analysisFile ? { analysisFile } : {}),
        ...(analysis?.bpm ? { bpm: analysis.bpm } : {}),
        ...(analysis ? { beatTimesSec: analysis.beatTimesSec } : {}),
      });

      return {
        content: [
          { type: "text", text: fileName },
          ...(analysis ? [{
            type: "text" as const,
            text:
              `Beat analysis: ${analysis.bpm ? `~${analysis.bpm} BPM; ` : ""}` +
              `sync points ${analysis.beatTimesSec.slice(0, 40).join(", ")}s. ` +
              `Use a FEW of these for planned hero reveals, transition accents and SFX; ` +
              `do not pulse every element on every beat. Full analysis: ${analysisFile}.`,
          }] : []),
        ],
        details: {
          prompt, durationSec, path: fileName, mimeType: result.mimeType,
          ...(analysisFile ? { analysisFile } : {}),
          ...(analysis?.bpm ? { bpm: analysis.bpm } : {}),
          ...(analysis ? { beatTimesSec: analysis.beatTimesSec } : {}),
        },
      };
    },
  };
}
