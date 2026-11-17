import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import { dominantHexes, imageContentFromFile, isLowContentImage } from "./image-content.js";

const LOW_CONTENT_WARNING =
  "⚠ This image is near-blank (a flat colour or decorative gradient with no real subject). " +
  "Do NOT use it as a product shot or a scene's focal image; at most use it as a subtle background. " +
  "Prefer screenshots, product UI, mascots, or photos with actual content.";

export interface WebFetchResponse {
  status: number;
  text: string;
}

export interface WebFetchToolOptions {
  fetch: (url: string, signal?: AbortSignal) => Promise<WebFetchResponse>;
}

const webFetchParameters = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL to fetch." }),
});

export function makeWebFetchTool(opts: WebFetchToolOptions): AgentTool<typeof webFetchParameters> {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a web page or JSON document by URL and return its body as text.",
    parameters: webFetchParameters,
    execute: async (_callId, params, signal) => {
      const url = params.url;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`Invalid URL: ${url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Disallowed URL scheme: ${parsed.protocol}`);
      }
      const response = await opts.fetch(url, signal);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Fetch failed (${response.status}) for ${url}`);
      }
      return {
        content: [{ type: "text", text: response.text }],
        details: { url, status: response.status, bytes: Buffer.byteLength(response.text, "utf8") },
      };
    },
  };
}

export interface ReadUploadToolOptions {
  sessionId: string;
  workspaces: WorkspaceManager;
}

const readUploadParameters = Type.Object({
  filename: Type.String({ description: "Filename within this session's uploads/ directory." }),
});

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export interface FetchBinaryResponse {
  status: number;
  contentType: string;
  bytes: Buffer;
}

export interface DownloadAssetToolOptions {
  sessionId: string;
  workspaces: WorkspaceManager;
  fetchBinary: (url: string, signal?: AbortSignal) => Promise<FetchBinaryResponse>;
  /** Default 10 MB. */
  maxBytes?: number;
}

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

const downloadAssetParameters = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL of an image to download." }),
});

export function makeDownloadAssetTool(
  opts: DownloadAssetToolOptions,
): AgentTool<typeof downloadAssetParameters> {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  return {
    name: "download_asset",
    label: "Download Asset",
    description:
      "Download an image (logo, product shot) by URL into the session's assets/ dir. Returns the local relative path to reference later.",
    parameters: downloadAssetParameters,
    execute: async (_callId, params, signal) => {
      let parsed: URL;
      try {
        parsed = new URL(params.url);
      } catch {
        throw new Error(`Invalid URL: ${params.url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Disallowed URL scheme: ${parsed.protocol}`);
      }

      const res = await opts.fetchBinary(params.url, signal);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Download failed (${res.status}) for ${params.url}`);
      }

      const baseType = res.contentType.split(";")[0]!.trim().toLowerCase();
      const ext = ALLOWED_IMAGE_TYPES[baseType];
      if (!ext) {
        throw new Error(`Disallowed content-type: ${res.contentType}`);
      }
      if (res.bytes.byteLength > maxBytes) {
        throw new Error(`Asset too large: ${res.bytes.byteLength} bytes (max ${maxBytes})`);
      }

      const hash = createHash("sha256").update(res.bytes).digest("hex").slice(0, 16);
      const fileName = `${hash}.${ext}`;
      const relPath = `assets/${fileName}`;
      const abs = join(opts.workspaces.paths(opts.sessionId).assets, fileName);
      await writeFile(abs, res.bytes);

      const lowContent = await isLowContentImage(res.bytes);
      // Keep the local path as the first content block so callers parse it
      // unchanged; surface the warning as a separate block when relevant.
      const content: (TextContent | ImageContent)[] = [{ type: "text", text: relPath }];
      if (lowContent) content.push({ type: "text", text: LOW_CONTENT_WARNING });

      // Show the model what it actually grabbed (best-effort; SVG/ICO decode
      // may fail → no image block) and name the dominant colors so brand hexes
      // come from pixels, not guesses.
      const imageBlock = await imageContentFromFile(abs, { maxDim: 768 });
      if (imageBlock) content.push(imageBlock);
      const hexes = await dominantHexes(res.bytes, 4);
      if (hexes.length > 0) {
        content.push({ type: "text", text: `Dominant colors of this image: ${hexes.join(", ")}` });
      }

      return {
        content,
        details: { url: params.url, contentType: baseType, path: relPath, bytes: res.bytes.byteLength, lowContent, dominantColors: hexes },
      };
    },
  };
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico"]);

export function makeReadUploadTool(opts: ReadUploadToolOptions): AgentTool<typeof readUploadParameters> {
  return {
    name: "read_upload",
    label: "Read Upload",
    description:
      "Read a file the user uploaded to this session. Images are shown to you directly.",
    parameters: readUploadParameters,
    execute: async (_callId, params) => {
      const raw = params.filename;
      const safe = basename(raw);
      if (safe !== raw || !SAFE_NAME.test(safe)) {
        throw new Error(`Invalid filename: ${raw}`);
      }
      const path = join(opts.workspaces.paths(opts.sessionId).uploads, safe);

      // Images: return the pixels, not mojibake from a utf8 read of a binary.
      if (IMAGE_EXTENSIONS.has(extname(safe).toLowerCase())) {
        const bytes = await readFile(path); // throws for missing files, like before
        const content: (TextContent | ImageContent)[] = [
          { type: "text", text: `Uploaded image "${safe}" (${bytes.byteLength} bytes):` },
        ];
        const imageBlock = await imageContentFromFile(path, { maxDim: 1024 });
        if (imageBlock) content.push(imageBlock);
        else content.push({ type: "text", text: "(preview unavailable — could not decode the image)" });
        const hexes = await dominantHexes(bytes, 4);
        if (hexes.length > 0) {
          content.push({ type: "text", text: `Dominant colors: ${hexes.join(", ")}` });
        }
        return { content, details: { filename: safe, bytes: bytes.byteLength, image: true } };
      }

      const text = await readFile(path, "utf8");
      return {
        content: [{ type: "text", text }],
        details: { filename: safe, bytes: Buffer.byteLength(text, "utf8") },
      };
    },
  };
}
