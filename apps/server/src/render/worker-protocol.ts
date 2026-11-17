/** Parent → child: the single render command sent right after `ready`. */
export interface RenderCommand {
  type: "render";
  /** Absolute path to the hyperframes project directory (contains index.html). */
  projectDir: string;
  /** Absolute path for the rendered MP4. The worker writes here on success. */
  outputPath: string;
  /** hyperframes --quality */
  quality?: "draft" | "standard" | "high";
  /** hyperframes --fps */
  fps?: 24 | 30 | 60;
  /**
   * Override for the renderer subprocess. Defaults to
   * `["npx", "--package=hyperframes", "hyperframes", "render", ...]`.
   * Unit tests pass a path to fake-renderer.mjs instead.
   */
  rendererCommand?: string[];
  /**
   * Hard ceiling in ms — kills even a progressing render (runaway backstop).
   * Default = 30 * 60 * 1000.
   */
  timeoutMs?: number;
  /**
   * Stall timeout in ms — kills the render only after this long with NO
   * renderer output. Any stdout/stderr resets it, so a slow-but-alive render
   * (2-vCPU prod takes ~4 min for a 1-min video) is never killed mid-progress.
   * Default = 5 * 60 * 1000.
   */
  stallTimeoutMs?: number;
}

/** Child → parent. */
export type WorkerMessage =
  | { type: "ready" }
  | { type: "progress"; percent: number; message?: string }
  | { type: "log"; line: string }
  | { type: "done"; mp4Path: string }
  | { type: "error"; message: string }
  /**
   * Emitted by LimitedRenderWorkerClient (never by the forked worker itself)
   * while waiting for a process-wide render slot. `position` is the queue
   * depth ahead of this caller at the time it queued — informational only,
   * not updated as the queue drains.
   */
  | { type: "queued"; position: number };
