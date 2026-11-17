// apps/server/src/tools/capture-tools.ts
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import { imageContentFromFile } from "./image-content.js";

/**
 * capture_website spawns `hyperframes capture` — the same headless-browser
 * capture pipeline the website-to-hyperframes skill uses interactively — and
 * feeds its outputs back to the research agent: extracted design tokens
 * (brand colors ordered by usage, real font families), the page copy, the
 * downloaded asset list, and actual SCREENSHOTS as image blocks so a
 * multimodal model finally sees what the site looks like.
 *
 * Everything lands under `<workspace-root>/capture/`; asset paths are
 * returned workspace-relative ("capture/assets/x.png") so write_brief can
 * reference them and the compose phase's existing copy step picks them up.
 */

export interface CaptureWebsiteToolOptions {
  sessionId: string;
  workspaces: WorkspaceManager;
  /** Override the spawned argv (tests). Default: npx hyperframes capture. */
  commandFor?: (url: string, outDir: string) => string[];
  /** Kill the capture after this long. Default 4 minutes. */
  timeoutMs?: number;
  /** Max screenshots to attach as image blocks. Default 3. */
  maxImages?: number;
}

const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

function defaultCommand(url: string, outDir: string): string[] {
  return [
    "npx", "--package=hyperframes", "hyperframes", "capture",
    url, "-o", outDir, "--json", "--max-screenshots", "8",
  ];
}

const captureParameters = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL of the website to capture." }),
});

interface TokensFile {
  title?: string;
  description?: string;
  ogImage?: string;
  colors?: string[];
  fonts?: Array<{ family?: string; name?: string; weights?: number[] }>;
  headings?: Array<{ level?: number; text?: string; fontSize?: string; color?: string }>;
  cssVariables?: Record<string, string>;
}

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

function runProcess(
  argv: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const [exe, ...args] = argv;
    const child = spawn(exe!, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(124); }, timeoutMs);
    const onAbort = () => { try { child.kill("SIGKILL"); } catch {} finish(130); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

function summarizeTokens(tokens: TokensFile | null): string {
  if (!tokens) return "(no design tokens extracted)";
  const lines: string[] = [];
  if (tokens.title) lines.push(`Site title: ${tokens.title}`);
  if (tokens.description) lines.push(`Description: ${tokens.description}`);
  const colors = (tokens.colors ?? []).slice(0, 12);
  if (colors.length > 0) {
    lines.push(`Brand colors by on-page usage (most-used first): ${colors.join(", ")}`);
  }
  const fonts = (tokens.fonts ?? [])
    .map((f) => {
      const family = f.family ?? f.name;
      if (!family) return null;
      const weights = f.weights?.length ? ` (weights ${f.weights.join("/")})` : "";
      return `${family}${weights}`;
    })
    .filter(Boolean)
    .slice(0, 8);
  if (fonts.length > 0) lines.push(`Fonts in use: ${fonts.join(", ")}`);
  const headings = (tokens.headings ?? []).slice(0, 5)
    .map((h) => `h${h.level ?? "?"} "${(h.text ?? "").slice(0, 80)}" ${h.fontSize ?? ""} ${h.color ?? ""}`.trim());
  if (headings.length > 0) lines.push(`Headings:\n  ${headings.join("\n  ")}`);
  return lines.join("\n");
}

export function makeCaptureWebsiteTool(
  opts: CaptureWebsiteToolOptions,
): AgentTool<typeof captureParameters> {
  const commandFor = opts.commandFor ?? defaultCommand;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxImages = opts.maxImages ?? 3;

  return {
    name: "capture_website",
    label: "Capture Website",
    description:
      "Capture a website with a headless browser: screenshots (returned as images you can " +
      "see), extracted brand design tokens (colors, fonts), page copy, and downloadable " +
      "assets saved under capture/assets/. Use this FIRST whenever the user provides a URL.",
    parameters: captureParameters,
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

      const root = opts.workspaces.paths(opts.sessionId).root;
      const outDir = join(root, "capture");
      const out = await runProcess(commandFor(params.url, outDir), timeoutMs, signal);
      if (out.code !== 0) {
        throw new Error(
          `Website capture failed (exit ${out.code}). Fall back to web_fetch + download_asset.\n` +
            `${out.stderr.slice(-800) || out.stdout.slice(-800)}`,
        );
      }

      const tokens = await readJsonIfPresent<TokensFile>(join(outDir, "extracted", "tokens.json"));
      let visibleText = "";
      try {
        visibleText = (await readFile(join(outDir, "extracted", "visible-text.txt"), "utf8")).slice(0, 2500);
      } catch {
        // Copy extraction is optional.
      }

      const assetFiles = await listFiles(join(outDir, "assets"));
      const svgFiles = await listFiles(join(outDir, "assets", "svgs"));
      const assetList = [
        ...assetFiles.map((f) => `capture/assets/${f}`),
        ...svgFiles.map((f) => `capture/assets/svgs/${f}`),
      ].slice(0, 40);

      // Screenshots the model can SEE: hero/page screenshots first, then the
      // asset contact sheets (the tool of choice for judging asset quality).
      const screenshotDir = join(outDir, "screenshots");
      const screenshots = (await listFiles(screenshotDir)).sort();
      const contactSheets = screenshots.filter((f) => f.startsWith("contact-sheet"));
      const pageShots = screenshots.filter((f) => !f.startsWith("contact-sheet"));
      const assetSheets = (await listFiles(join(outDir, "assets")))
        .filter((f) => f.startsWith("contact-sheet"));
      const candidates = [
        ...pageShots.slice(0, 2).map((f) => join(screenshotDir, f)),
        ...contactSheets.slice(0, 1).map((f) => join(screenshotDir, f)),
        ...assetSheets.slice(0, 1).map((f) => join(outDir, "assets", f)),
      ];
      const images: ImageContent[] = [];
      for (const path of candidates) {
        if (images.length >= maxImages) break;
        const block = await imageContentFromFile(path, { maxDim: 1280 });
        if (block) images.push(block);
      }

      const summary = [
        `Captured ${params.url} into capture/ (${assetList.length} assets listed, ${screenshots.length} screenshots).`,
        summarizeTokens(tokens),
        assetList.length > 0
          ? `Asset files (reference these paths in the brief):\n  ${assetList.join("\n  ")}`
          : "No assets were downloaded.",
        visibleText ? `Page copy (DOM order, truncated):\n${visibleText}` : "",
        images.length > 0
          ? `Attached ${images.length} screenshot(s)/contact sheet(s) below — study them for the brand's actual look.`
          : "",
      ].filter(Boolean).join("\n\n");

      const content: (TextContent | ImageContent)[] = [{ type: "text", text: summary }, ...images];
      return {
        content,
        details: {
          url: params.url,
          outDir: "capture",
          assetCount: assetList.length,
          screenshotCount: screenshots.length,
          colors: tokens?.colors?.slice(0, 12) ?? [],
          fonts: (tokens?.fonts ?? []).map((f) => f.family ?? f.name).filter(Boolean).slice(0, 8),
        },
      };
    },
  };
}
