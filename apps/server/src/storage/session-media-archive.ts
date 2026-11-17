import { existsSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { SessionRepository } from "../sessions/session-repository.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import { SessionQueue } from "../orchestrator/session-queue.js";
import { sleepUnlessAborted } from "../retry.js";
import type { StorageGateway } from "./storage-gateway.js";

/**
 * Heavy media (spec §5): rendered video + subtitles, voiceover/music audio,
 * generated/downloaded images. Composition code (.html/.tsx/.json) is a phase
 * input and stays local-only.
 */
const HEAVY_MEDIA_EXTENSIONS = new Set([
  ".mp4", ".mov", ".webm",
  ".mp3", ".wav", ".m4a",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
  ".srt",
]);

/**
 * `uploads/` archives wholesale (user files of any type); `assets/`,
 * `composition/` and `output/` archive heavy media only; `logs/`, `artifacts/`
 * and root-level bookkeeping files (initial-message.json) never leave disk.
 */
export function isArchivable(rel: string): boolean {
  const slash = rel.indexOf("/");
  if (slash === -1) return false; // root-level bookkeeping file
  const top = rel.slice(0, slash);
  if (top === "logs" || top === "artifacts") return false;
  if (top === "uploads") return true;
  return HEAVY_MEDIA_EXTENSIONS.has(extname(rel).toLowerCase());
}

/** No leading slash, no empty/"."/".." segments — keys must stay under the prefix. */
function isSafeRelPath(rel: string): boolean {
  if (rel.startsWith("/")) return false;
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Phases read uploads/assets/composition; output/ holds final deliverables
 * that are only ever served (via signed URL once archived), so restore skips
 * it — otherwise every re-run would pull historical mp4s back for nothing.
 */
const RESTORE_EXCLUDED_TOP_DIRS = new Set(["output"]);

export interface SessionMediaArchiveOptions {
  storage: StorageGateway;
  workspaces: WorkspaceManager;
  sessions: SessionRepository;
  /** Per-file upload attempts including the first; default 4. */
  attempts?: number;
  /** First backoff delay, doubling per retry; default 2000ms. Tests pass 1. */
  baseDelayMs?: number;
  /** Failure sink; default console.warn. */
  log?: (message: string) => void;
  /** Signed URL lifetime; default 15 minutes (spec §5). */
  signedUrlTtlMs?: number;
}

export interface ArchiveSummary {
  uploaded: number;
  failed: number;
}

/**
 * Owns the workspace ⇄ object-store media lifecycle (spec §5):
 *  - archiveSession: after render.done, upload heavy media, verify (gateway
 *    validation + size check), delete the local copy only on success. Per-file
 *    failures keep the local file and never throw — the user keeps watching
 *    from disk; the next render.done re-attempts.
 *  - restoreMissing / ensureLocal: pull archived files back before a phase
 *    re-run reads them.
 *  - signedUrlFor: files-route fallback once the local copy is gone.
 *  - deleteRemote: prefix cleanup on session delete.
 *
 * Key convention: users/<userId>/sessions/<sid>/<workspace-relative path>.
 * Mutating flows are serialized per session on a SessionQueue so a background
 * archive cannot delete files while a restore repopulates them.
 */
export class SessionMediaArchive {
  private queue = new SessionQueue();
  private attempts: number;
  private baseDelayMs: number;
  private log: (message: string) => void;
  private signedUrlTtlMs: number;

  constructor(private opts: SessionMediaArchiveOptions) {
    this.attempts = opts.attempts ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 2000;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.signedUrlTtlMs = opts.signedUrlTtlMs ?? 15 * 60 * 1000;
  }

  /** Trailing slash keeps sibling session ids with a shared prefix disjoint. */
  private prefixOf(userId: string, sessionId: string): string {
    return `users/${userId}/sessions/${sessionId}/`;
  }

  private async ownerOf(sessionId: string): Promise<string | null> {
    const row = await this.opts.sessions.get(sessionId);
    return row?.userId ?? null;
  }

  async archiveSession(sessionId: string): Promise<ArchiveSummary> {
    return this.queue.enqueue(sessionId, async () => {
      const userId = await this.ownerOf(sessionId);
      if (!userId) return { uploaded: 0, failed: 0 };
      const root = this.opts.workspaces.paths(sessionId).root;
      const summary: ArchiveSummary = { uploaded: 0, failed: 0 };
      for (const rel of await this.archivableFiles(root)) {
        try {
          await this.uploadVerifyDelete(join(root, rel), this.prefixOf(userId, sessionId) + rel);
          summary.uploaded++;
        } catch (err) {
          // Local copy stays — the user keeps watching from disk (spec §8).
          summary.failed++;
          this.log(
            `[media-archive] ${sessionId}: upload failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return summary;
    });
  }

  /**
   * Download every archived object (except output/) whose local copy is
   * missing. Called before a phase (re-)run; per-file failures are logged, not
   * thrown — a phase that truly needs the file fails with its own clear error.
   */
  async restoreMissing(sessionId: string): Promise<void> {
    return this.queue.enqueue(sessionId, async () => {
      const userId = await this.ownerOf(sessionId);
      if (!userId) return;
      const prefix = this.prefixOf(userId, sessionId);
      const root = this.opts.workspaces.paths(sessionId).root;
      for (const key of await this.opts.storage.list(prefix)) {
        const rel = key.slice(prefix.length);
        if (!isSafeRelPath(rel)) {
          this.log(`[media-archive] ${sessionId}: skipping unsafe object key ${key}`);
          continue;
        }
        if (RESTORE_EXCLUDED_TOP_DIRS.has(rel.split("/")[0]!)) continue;
        const abs = join(root, rel);
        if (existsSync(abs)) continue;
        try {
          await this.opts.storage.download(key, abs);
        } catch (err) {
          this.log(
            `[media-archive] ${sessionId}: restore failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });
  }

  /** Make one workspace-relative file present locally; true if it now exists. */
  async ensureLocal(sessionId: string, rel: string): Promise<boolean> {
    if (!isSafeRelPath(rel)) return false;
    return this.queue.enqueue(sessionId, async () => {
      const abs = join(this.opts.workspaces.paths(sessionId).root, rel);
      if (existsSync(abs)) return true;
      const userId = await this.ownerOf(sessionId);
      if (!userId) return false;
      const key = this.prefixOf(userId, sessionId) + rel;
      if (!(await this.opts.storage.exists(key))) return false;
      await this.opts.storage.download(key, abs);
      return true;
    });
  }

  /** Signed read URL for an archived file, or null when no such object exists. */
  async signedUrlFor(sessionId: string, rel: string): Promise<string | null> {
    if (!isSafeRelPath(rel)) return null;
    const userId = await this.ownerOf(sessionId);
    if (!userId) return null;
    const key = this.prefixOf(userId, sessionId) + rel;
    if (!(await this.opts.storage.exists(key))) return null;
    // exists→signedUrl can race a concurrent deleteRemote (this method is
    // deliberately unqueued); treat a lost race as a miss, not an error.
    return this.opts.storage.signedUrl(key, this.signedUrlTtlMs).catch(() => null);
  }

  /**
   * Delete every archived object for the session. MUST run before the
   * creator_sessions row is deleted — the key prefix embeds the owner's id.
   */
  async deleteRemote(sessionId: string): Promise<void> {
    return this.queue.enqueue(sessionId, async () => {
      const userId = await this.ownerOf(sessionId);
      if (!userId) return;
      await this.opts.storage.deletePrefix(this.prefixOf(userId, sessionId));
    });
  }

  /** Workspace-relative archivable paths, sorted for deterministic order. */
  private async archivableFiles(root: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // workspace never materialized — nothing to archive
      throw err;
    }
    return entries
      .filter((e) => e.isFile())
      .map((e) => relative(root, join(e.parentPath, e.name)))
      .filter((rel) => isArchivable(rel))
      .sort();
  }

  /**
   * Upload with retry/backoff, verify remote size, then delete the local copy.
   * Intentionally retries ANY error (not just isTransientNetworkError): GCS
   * client failures take many shapes, this path is background, and a wasted
   * retry is cheap.
   *
   * The local file is deleted only if it is byte-identical to what was
   * uploaded: nothing serializes workspace writers (e.g. a user re-upload)
   * against this queue, so re-stat after the upload and treat any change as a
   * failure — the file stays local and the next render.done re-archives it.
   */
  private async uploadVerifyDelete(abs: string, key: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const before = await stat(abs);
        const { size } = await this.opts.storage.upload(abs, key);
        if (size !== before.size) {
          throw new Error(`size mismatch after upload: local ${before.size}, remote ${size}`);
        }
        const after = await stat(abs);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw new Error("local file changed during upload");
        }
        break;
      } catch (err) {
        if (attempt >= this.attempts) throw err;
        await sleepUnlessAborted(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
    await unlink(abs);
  }
}
