import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve, relative, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Brief, CompositionData, NarrationData, PhaseId, Script, ServerEvent } from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import type { RenderWorkerClient } from "../render/render-worker-client.js";
import { buildSubtitles } from "../subtitles/build-subtitles.js";
import { segmentsToSrt } from "../subtitles/srt.js";

export interface RenderPhaseHandlerOptions {
  workerClient: RenderWorkerClient;
  /** Forwarded to the worker: hard runaway cap. Default: 30 minutes. */
  timeoutMs?: number;
  /** Forwarded to the worker: no-output stall kill. Default: 5 minutes. */
  stallTimeoutMs?: number;
  /** Forwarded to the worker (passed through to `hyperframes render --quality`). */
  quality?: "draft" | "standard" | "high";
  /** Forwarded to the worker (passed through to `hyperframes render --fps`). */
  fps?: 24 | 30 | 60;
}

export class RenderPhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "render";
  constructor(private opts: RenderPhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    if (ctx.signal.aborted) throw new Error("Aborted");

    // 1. Load the composition authored by the compose phase.
    const compEnv = await ctx.artifacts.get<CompositionData>(ctx.sessionId, "composition");
    if (!compEnv) throw new Error("render phase requires a composition artifact, none found");

    const paths = ctx.workspaces.paths(ctx.sessionId);
    const entryPath = join(paths.composition, compEnv.data.entry);
    if (!existsSync(entryPath)) {
      throw new Error(`composition entry not found on disk: ${entryPath}`);
    }

    // 2. Run the renderer. The worker runs with cwd=projectDir, so a relative output
    // path would land inside the composition dir; resolve to absolute.
    const outputPath = resolve(paths.output, `${randomUUID()}.mp4`);
    yield { type: "phase.progress", phase: this.phase, message: "Starting render" };

    for await (const msg of this.opts.workerClient.render({
      projectDir: paths.composition,
      outputPath,
      quality: this.opts.quality,
      fps: this.opts.fps,
      timeoutMs: this.opts.timeoutMs,
      stallTimeoutMs: this.opts.stallTimeoutMs,
      signal: ctx.signal,
    })) {
      switch (msg.type) {
        case "ready":
          break;
        case "queued":
          yield {
            type: "phase.progress",
            phase: this.phase,
            message:
              msg.position === 1
                ? "Waiting for a render slot — 1 render ahead of yours"
                : `Waiting for a render slot — ${msg.position} renders ahead of yours`,
          };
          break;
        case "progress":
          yield { type: "render.progress", percent: msg.percent };
          break;
        case "log":
          yield { type: "phase.progress", phase: this.phase, message: msg.line };
          break;
        case "done": {
          // Store the workspace-relative path (like subtitles' srtPath): it is
          // served through workspace-rooted routes and doubles as the archive
          // object key, while the worker's absolute path goes stale the moment
          // the local copy is archived to GCS.
          await ctx.artifacts.put(
            ctx.sessionId,
            "mp4",
            { path: relative(paths.root, msg.mp4Path) },
            { derivedFrom: [{ kind: "composition", version: compEnv.version }] },
          );
          try {
            await this.maybeEmitSubtitles(ctx, msg.mp4Path);
          } catch (err) {
            // Subtitles are a secondary deliverable — never fail a successful render over them.
            yield {
              type: "phase.progress",
              phase: this.phase,
              message: `subtitle generation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          yield { type: "render.done", mp4Path: msg.mp4Path };
          return;
        }
        case "error":
          yield { type: "render.error", error: msg.message };
          throw new Error(msg.message);
      }
    }

    throw new Error("Render worker ended without a terminal message");
  }

  private async maybeEmitSubtitles(ctx: PhaseContext, mp4Path: string): Promise<void> {
    const briefEnv = await ctx.artifacts.get<Brief>(ctx.sessionId, "brief");
    if (briefEnv?.data.constraints.subtitles !== true) return;

    const scriptEnv = await ctx.artifacts.get<Script>(ctx.sessionId, "script");
    const narrationEnv = await ctx.artifacts.get<NarrationData>(ctx.sessionId, "narration");
    if (!scriptEnv || !narrationEnv) return; // nothing to caption

    const segments = buildSubtitles(scriptEnv.data.scenes, narrationEnv.data);
    if (segments.length === 0) return;

    const srtName = basename(mp4Path).replace(/\.mp4$/i, ".srt");
    const srtAbs = resolve(ctx.workspaces.paths(ctx.sessionId).output, srtName);
    const srtPath = `output/${srtName}`; // workspace-root-relative, served via /files/*
    await writeFile(srtAbs, segmentsToSrt(segments), "utf8");

    await ctx.artifacts.put(
      ctx.sessionId,
      "subtitles",
      { language: "en", srtPath, segments },
      { derivedFrom: [{ kind: "script", version: scriptEnv.version }, { kind: "narration", version: narrationEnv.version }] },
    );
  }
}
