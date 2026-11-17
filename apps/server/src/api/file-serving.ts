// apps/server/src/api/file-serving.ts
import { createReadStream, statSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SessionMediaArchive } from "../storage/session-media-archive.js";

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".srt": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
};

function mimeOf(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

interface ParsedRange {
  start: number;
  end: number; // inclusive
}

function parseRange(header: string, size: number): ParsedRange | "unsatisfiable" | null {
  const m = /^bytes=(\d+)?-(\d+)?$/.exec(header.trim());
  if (!m) return null;
  let start = m[1] !== undefined ? Number(m[1]) : NaN;
  let end = m[2] !== undefined ? Number(m[2]) : NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    // suffix range: -N → last N bytes
    const suffix = end;
    if (suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start > end || start >= size) return "unsatisfiable";
  if (end >= size) end = size - 1;
  return { start, end };
}

/**
 * Stream a workspace-relative file (with Range support) or 302-redirect to a
 * signed URL when the local copy has been archived to GCS. Runs a path-escape
 * check against `root`. The caller is responsible for authorization.
 */
export async function serveWorkspaceFile(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { root: string; relative: string; sid: string; media?: SessionMediaArchive },
): Promise<unknown> {
  const target = resolve(opts.root, opts.relative);
  if (!target.startsWith(resolve(opts.root) + "/") && target !== resolve(opts.root)) {
    return reply.code(400).send({ error: "path escapes workspace" });
  }
  if (!existsSync(target)) {
    // Local miss → archived copy? 302 to a short-lived signed URL. The
    // browser follows the redirect for <video>/<audio>/<img>, and Range
    // requests work natively against GCS signed URLs (spec §5). When the
    // signature expires the player re-requests this route for a fresh one.
    const url = opts.media ? await opts.media.signedUrlFor(opts.sid, opts.relative) : null;
    if (url) {
      // Capability-URL hygiene: don't let any cache replay the redirect.
      reply.header("Cache-Control", "private, no-store");
      return reply.redirect(url, 302);
    }
    return reply.code(404).send({ error: "file not found" });
  }
  const stat = statSync(target);
  if (!stat.isFile()) {
    return reply.code(404).send({ error: "not a file" });
  }

  const rangeHeader = req.headers.range;
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", mimeOf(target));

  if (rangeHeader) {
    const range = parseRange(rangeHeader, stat.size);
    if (range === "unsatisfiable") {
      reply.code(416).header("Content-Range", `bytes */${stat.size}`).send();
      return reply;
    }
    if (range !== null) {
      const length = range.end - range.start + 1;
      reply.code(206);
      reply.header("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
      reply.header("Content-Length", String(length));
      return reply.send(createReadStream(target, { start: range.start, end: range.end }));
    }
  }

  reply.header("Content-Length", String(stat.size));
  return reply.send(createReadStream(target));
}
