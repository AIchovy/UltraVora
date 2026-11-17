import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, extname } from "node:path";

export interface WorkspacePaths {
  root: string;
  uploads: string;
  artifacts: string;
  assets: string;
  composition: string;
  /**
   * Per-version composition snapshots (index.v<N>.html) for the mp4 restore
   * flow. Deliberately OUTSIDE composition/: a second root .html next to
   * index.html trips the renderer's multiple_root_compositions lint (risk of
   * duplicate audio if the runtime discovers both entry points).
   */
  versions: string;
  output: string;
  logs: string;
}

export interface WorkspaceOptions {
  maxUploadBytes?: number;
  allowedExtensions?: string[];
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const DEFAULT_ALLOWED = [
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
  ".mp4", ".mov", ".webm",
  ".mp3", ".wav", ".m4a",
  ".pdf", ".txt", ".md",
];

export class WorkspaceManager {
  private maxUploadBytes: number;
  private allowedExtensions: Set<string>;

  constructor(private baseDir: string, opts: WorkspaceOptions = {}) {
    this.maxUploadBytes = opts.maxUploadBytes ?? 50 * 1024 * 1024;
    this.allowedExtensions = new Set(
      (opts.allowedExtensions ?? DEFAULT_ALLOWED).map((e) => e.toLowerCase()),
    );
  }

  paths(sessionId: string): WorkspacePaths {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
    }
    const root = join(this.baseDir, sessionId);
    return {
      root,
      uploads: join(root, "uploads"),
      artifacts: join(root, "artifacts"),
      assets: join(root, "assets"),
      composition: join(root, "composition"),
      versions: join(root, "versions"),
      output: join(root, "output"),
      logs: join(root, "logs"),
    };
  }

  async init(sessionId: string): Promise<WorkspacePaths> {
    const p = this.paths(sessionId);
    for (const dir of [p.uploads, p.artifacts, p.assets, p.composition, p.versions, p.output, p.logs]) {
      await mkdir(dir, { recursive: true });
    }
    return p;
  }

  async saveUpload(sessionId: string, filename: string, data: Buffer): Promise<string> {
    if (data.byteLength > this.maxUploadBytes) {
      throw new Error(`Upload exceeds max size of ${this.maxUploadBytes} bytes`);
    }
    const safeName = basename(filename);
    const ext = extname(safeName);
    if (!this.allowedExtensions.has(ext.toLowerCase())) {
      throw new Error(`Disallowed file extension: ${ext.toLowerCase() || "(none)"}`);
    }
    const dir = this.paths(sessionId).uploads;
    const stem = basename(safeName, ext);
    // Write with the exclusive "wx" flag so a colliding basename never clobbers an
    // existing upload; on collision, suffix the stem (-2, -3, …) until a free name
    // is found. This keeps each returned path pointing at a distinct file, which the
    // labeled @asset map (logo/imageN → path) downstream relies on.
    for (let attempt = 0; ; attempt++) {
      const candidate = attempt === 0 ? safeName : `${stem}-${attempt + 1}${ext}`;
      const dest = join(dir, candidate);
      try {
        await writeFile(dest, data, { flag: "wx" });
        return dest;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
    }
  }
}
