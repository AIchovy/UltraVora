// apps/server/src/tools/add-registry-item-tool.ts
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import { REGISTRY_DIR } from "../registry/registry-loader.js";

interface RegistryFile {
  path: string;
  target: string;
  type: string;
}
interface RegistryManifest {
  name: string;
  type: "hyperframes:block" | "hyperframes:component";
  title?: string;
  dimensions?: { width: number; height: number };
  duration?: number;
  files: RegistryFile[];
  params?: Array<{
    key: string;
    label: string;
    type: "color" | "string" | "number" | "boolean" | "enum";
    default: unknown;
  }>;
}

const parameters = Type.Object({
  name: Type.String({
    description: "Registry item name from the catalog, e.g. 'macos-notification' or 'caption-clip-wipe'.",
  }),
  values: Type.Optional(Type.Record(Type.String(), Type.String(), {
    description:
      "Manifest tunable values keyed exactly as shown in <effect_route>, e.g. " +
      "{'--bg-color':'#101018','--accent-color':'#FF3366'}.",
  })),
  textReplacements: Type.Optional(Type.Array(Type.Object({
    from: Type.String({ description: "Exact stock text found in the installed block." }),
    to: Type.String({ description: "On-brand replacement text from the brief/script." }),
  }), { maxItems: 8 })),
});

export interface AddRegistryItemToolOptions {
  sessionId: string;
  workspaces: WorkspaceManager;
  /** Override the registry directory (tests). Defaults to the vendored registry. */
  registryDir?: string;
}

/** Targets are authored as `compositions/...`; the workspace composition dir IS
 *  that root, so strip the prefix. Asset targets (models/, assets/, lib/) pass through. */
function remapTarget(target: string): string {
  return target.startsWith("compositions/") ? target.slice("compositions/".length) : target;
}

async function readManifest(registryDir: string, name: string): Promise<{ dir: string; manifest: RegistryManifest }> {
  for (const kind of ["blocks", "components"] as const) {
    const dir = join(registryDir, kind, name);
    try {
      const raw = await readFile(join(dir, "registry-item.json"), "utf8");
      return { dir, manifest: JSON.parse(raw) as RegistryManifest };
    } catch {
      // try the other kind
    }
  }
  throw new Error(`Unknown registry item: ${name}`);
}

const TEXT_FILE = /\.(?:html|css|js|json)$/i;

function validateCustomizations(
  manifest: RegistryManifest,
  values: Record<string, string>,
): void {
  const params = new Map((manifest.params ?? []).map((param) => [param.key, param]));
  for (const [key, value] of Object.entries(values)) {
    const param = params.get(key);
    if (!param) throw new Error(`Registry item "${manifest.name}" has no tunable named ${key}`);
    if (param.type === "color" && !/^#[0-9a-f]{3,8}$/i.test(value)) {
      throw new Error(`Registry tunable ${key} requires a hex color, got ${value}`);
    }
    if (param.type === "number" && !Number.isFinite(Number(value))) {
      throw new Error(`Registry tunable ${key} requires a number, got ${value}`);
    }
    if (param.type === "boolean" && !/^(?:true|false)$/i.test(value)) {
      throw new Error(`Registry tunable ${key} requires true or false, got ${value}`);
    }
  }
}

function visibleTextCandidates(html: string): string[] {
  const plain = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
  return [...new Set(plain.split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()))]
    .filter((line) => line.length >= 2 && line.length <= 100 && /[\p{L}\p{N}]/u.test(line))
    .slice(0, 20);
}

function replaceExact(source: string, from: string, to: string): { source: string; count: number } {
  if (!from || from === to) return { source, count: 0 };
  // Short hex values such as #000 must not corrupt longer colors (#000000).
  if (/^#[0-9a-f]{3,8}$/i.test(from)) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^0-9a-fA-F])(${escaped})(?![0-9a-fA-F])`, "g");
    let count = 0;
    return {
      source: source.replace(pattern, (_match, prefix: string) => {
        count++;
        return `${prefix}${to}`;
      }),
      count,
    };
  }
  const count = source.split(from).length - 1;
  return { source: count > 0 ? source.split(from).join(to) : source, count };
}

/**
 * In-process `hyperframes add`: copies a registry item's files into the session's
 * composition dir (binary-safe) and returns the wiring information the agent
 * needs. The compose agent cannot run shell or copy binary assets via
 * write_composition_file, so this tool does the install; the agent then wires the
 * result with write_composition_file (see the hyperframes-registry skill).
 */
export function makeAddRegistryItemTool(opts: AddRegistryItemToolOptions): AgentTool<typeof parameters> {
  const registryDir = opts.registryDir ?? REGISTRY_DIR;
  return {
    name: "add_registry_item",
    label: "Add Registry Item",
    description:
      "Install a hyperframes registry block or component into the composition project. Copies " +
      "its files (including binary assets) into the composition dir. For a BLOCK, returns the " +
      "data-composition-src wiring snippet (with the correct id, width, height, duration) to add " +
      "to index.html plus visible stock-text candidates; values and textReplacements customize " +
      "the copied source before wiring. For a COMPONENT, returns the snippet's HTML/CSS/JS to " +
      "merge into your composition. Choose names from the effect route in your system prompt.",
    parameters,
    execute: async (_callId: string, params: Static<typeof parameters>) => {
      const { dir: itemDir, manifest } = await readManifest(registryDir, params.name);
      const compositionDir = opts.workspaces.paths(opts.sessionId).composition;
      const values = params.values ?? {};
      validateCustomizations(manifest, values);

      const copied: string[] = [];
      let blockHtmlRel: string | null = null;
      let componentHtmlRel: string | null = null;

      for (const f of manifest.files) {
        const rel = remapTarget(f.target);
        if (isAbsolute(rel)) throw new Error(`Bad registry target (absolute): ${f.target}`);
        const dest = normalize(join(compositionDir, rel));
        const within = relative(compositionDir, dest);
        if (within.startsWith("..") || isAbsolute(within)) {
          throw new Error(`Registry target escapes composition dir: ${f.target}`);
        }
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(itemDir, f.path), dest);
        copied.push(rel);
        if (f.type === "hyperframes:composition") blockHtmlRel = rel;
        if (f.type === "hyperframes:snippet") componentHtmlRel = rel;
      }

      // Registry manifests already declare brand-color parameters but the old
      // installer discarded them. Apply them directly to copied text sources:
      // this also reaches shader/Canvas literals where CSS variables cannot.
      const replacements = [
        ...(manifest.params ?? []).flatMap((param) => {
          const value = values[param.key];
          return value === undefined || typeof param.default !== "string"
            ? []
            : [{ from: param.default, to: value }];
        }),
        ...(params.textReplacements ?? []),
      ];
      const replacementCounts = new Map<string, number>();
      for (const rel of copied.filter((file) => TEXT_FILE.test(file))) {
        const path = join(compositionDir, rel);
        let source = await readFile(path, "utf8");
        let changed = false;
        for (const replacement of replacements) {
          const result = replaceExact(source, replacement.from, replacement.to);
          const count = result.count;
          if (count === 0) continue;
          source = result.source;
          replacementCounts.set(
            replacement.from,
            (replacementCounts.get(replacement.from) ?? 0) + count,
          );
          changed = true;
        }
        if (changed) await writeFile(path, source, "utf8");
      }

      if (manifest.type === "hyperframes:block") {
        const htmlRel = blockHtmlRel ?? copied.find((c) => c.endsWith(".html")) ?? `${params.name}.html`;
        const html = await readFile(join(compositionDir, htmlRel), "utf8");
        const idMatch = html.match(/data-composition-id="([^"]+)"/);
        const compId = idMatch?.[1] ?? params.name;
        const w = manifest.dimensions?.width ?? 1920;
        const h = manifest.dimensions?.height ?? 1080;
        const dur = manifest.duration ?? 5;
        const snippet =
          `<div\n` +
          `  data-composition-id="${compId}"\n` +
          `  data-composition-src="${htmlRel}"\n` +
          `  data-start="0"\n` +
          `  data-duration="${dur}"\n` +
          `  data-track-index="2"\n` +
          `  data-width="${w}"\n` +
          `  data-height="${h}"\n` +
          `></div>`;
        const text =
          `Installed block "${params.name}" (${copied.length} file(s): ${copied.join(", ")}).\n\n` +
          (manifest.params?.length
            ? `Available tunables: ${manifest.params.map((param) =>
                `${param.key} (${param.label}, default ${String(param.default)})`,
              ).join(", ")}.\n` : "") +
          (Object.keys(values).length
            ? `Applied tunables: ${Object.entries(values).map(([key, value]) => `${key}=${value}`).join(", ")}.\n`
            : "") +
          (params.textReplacements?.length
            ? `Applied ${[...replacementCounts.values()].reduce((a, b) => a + b, 0)} exact text replacement(s).\n`
            : "") +
          (visibleTextCandidates(html).length
            ? `Visible-text candidates to replace before shipping: ${visibleTextCandidates(html).map((value) => JSON.stringify(value)).join(", ")}\n\n`
            : "\n") +
          `Wire it into index.html by adding this element inside the root composition. Adjust ` +
          `data-start, data-duration (<= ${dur}), and data-track-index to place it in your timeline:\n\n` +
          snippet;
        return {
          content: [{ type: "text", text }],
          details: {
            name: params.name, kind: "block", compositionId: compId, src: htmlRel,
            width: w, height: h, duration: dur, files: copied, values,
            replacementsApplied: [...replacementCounts.values()].reduce((a, b) => a + b, 0),
          },
        };
      }

      // component
      const htmlRel = componentHtmlRel ?? copied.find((c) => c.endsWith(".html")) ?? `components/${params.name}.html`;
      const snippetContent = await readFile(join(compositionDir, htmlRel), "utf8");
      const text =
        `Installed component "${params.name}" at ${htmlRel}. Merge its parts into your ` +
        `composition: HTML elements inside the relevant scene, the <style> rules into your ` +
        `styles, and any <script> / GSAP timeline calls into your script (read the snippet's ` +
        `comment header for usage). Snippet contents:\n\n` +
        snippetContent;
      return {
        content: [{ type: "text", text }],
        details: { name: params.name, kind: "component", src: htmlRel, files: copied },
      };
    },
  };
}
