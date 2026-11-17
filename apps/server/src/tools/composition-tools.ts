import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

export interface WriteCompositionFileToolOptions {
  sessionId: string;
  workspaces: WorkspaceManager;
}

/**
 * True for refs that point outside the composition dir (or are not file paths):
 * scheme URLs (http:, https:, data:, blob:…), protocol-relative (//host), and
 * pure fragments (#id, e.g. SVG internal refs). Everything else is a local file.
 */
function isExternalOrFragmentRef(url: string): boolean {
  const t = url.trim();
  if (t === "" || t.startsWith("#")) return true;
  if (t.startsWith("//")) return true;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t);
}

/** Drop a `?query` segment from a local ref, preserving any trailing `#fragment`. */
function stripQuery(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const hash = url.indexOf("#", q);
  return hash === -1 ? url.slice(0, q) : url.slice(0, q) + url.slice(hash);
}

/**
 * Remove cache-buster query strings (e.g. `logo.png?v=2`) from local asset
 * references in HTML/CSS. The hyperframes validation server serves the
 * composition dir as static files and 404s on a local URL that carries a query
 * string, so a stray `?v=…` fails validation even though the file exists.
 * Absolute/external URLs keep their query strings; only local refs are cleaned.
 */
export function stripLocalAssetQueryStrings(content: string): string {
  const clean = (val: string): string => (isExternalOrFragmentRef(val) ? val : stripQuery(val));
  return content
    // src="…" / href="…" (single or double quoted)
    .replace(/\b(src|href)\s*=\s*(["'])(.*?)\2/gi, (m, attr, q, val) => {
      const c = clean(val);
      return c === val ? m : `${attr}=${q}${c}${q}`;
    })
    // CSS url(…) — optionally quoted
    .replace(/url\(\s*(["']?)([^)]*?)\1\s*\)/gi, (m, q, val) => {
      const c = clean(val);
      return c === val ? m : `url(${q}${c}${q})`;
    });
}

const SANITIZED_EXTENSIONS = new Set([".html", ".htm", ".css"]);

const writeCompositionFileParameters = Type.Object({
  path: Type.String({
    description: "Relative path inside the composition dir, e.g. 'index.html' or 'scenes/intro.html'.",
  }),
  content: Type.String({ description: "Full file contents to write." }),
});

export function makeWriteCompositionFileTool(
  opts: WriteCompositionFileToolOptions,
): AgentTool<typeof writeCompositionFileParameters> {
  return {
    name: "write_composition_file",
    label: "Write Composition File",
    description:
      "Write a file into the composition project dir (index.html, sub-compositions, CSS). Paths must stay inside the composition dir.",
    parameters: writeCompositionFileParameters,
    execute: async (_callId, params) => {
      const rel = params.path;
      if (isAbsolute(rel)) {
        throw new Error(`Invalid composition path (must be relative): ${rel}`);
      }
      const compositionDir = opts.workspaces.paths(opts.sessionId).composition;
      const abs = normalize(join(compositionDir, rel));
      const within = relative(compositionDir, abs);
      if (within.startsWith("..") || isAbsolute(within)) {
        throw new Error(`Invalid composition path (escapes composition dir): ${rel}`);
      }
      const content = SANITIZED_EXTENSIONS.has(extname(abs).toLowerCase())
        ? stripLocalAssetQueryStrings(params.content)
        : params.content;

      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      return {
        content: [{ type: "text", text: `Wrote ${within}.` }],
        details: { path: within, bytes: Buffer.byteLength(content, "utf8") },
      };
    },
  };
}
