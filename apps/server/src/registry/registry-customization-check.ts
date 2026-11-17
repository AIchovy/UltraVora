import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative } from "node:path";
import type { Design } from "@ultracreator/shared";
import { REGISTRY_DIR } from "./registry-loader.js";

function visibleBodyText(html: string): string[] {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const plain = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
  return [...new Set(plain.split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()))]
    .filter((line) => line.length >= 6 && line.length <= 120 && /[\p{L}\p{N}]/u.test(line));
}

function normalizeHex(value: string): string | null {
  const match = value.trim().toLowerCase().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!match) return null;
  const raw = match[1]!;
  return raw.length === 3 ? `#${[...raw].map((char) => char + char).join("")}` : `#${raw}`;
}

function hasExactHex(source: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^0-9a-fA-F])${escaped}(?![0-9a-fA-F])`, "i").test(source);
}

interface RegistryManifest {
  files?: Array<{ path: string; type: string }>;
  params?: Array<{ key: string; label: string; type: string; default: unknown }>;
}

/**
 * Rejects the two common ways a catalog block leaks into a final promo as a
 * recognizable demo: untouched stock copy and unchanged manifest brand colors.
 */
export async function findRegistryCustomizationViolations(
  projectDir: string,
  design: Design,
  registryDir: string = REGISTRY_DIR,
): Promise<string[]> {
  let index: string;
  try { index = await readFile(join(projectDir, "index.html"), "utf8"); } catch { return []; }
  const sources = [...index.matchAll(/data-composition-src\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1]!)
    .filter((source, index, all) => all.indexOf(source) === index);
  const allowedColors = new Set([
    ...design.palette.map((entry) => entry.hex),
    ...(design.colorRoles ? Object.values(design.colorRoles) : []),
  ].map(normalizeHex).filter((value): value is string => value !== null));
  const violations: string[] = [];

  for (const source of sources) {
    if (isAbsolute(source) || /^https?:/i.test(source)) continue;
    const installedPath = normalize(join(projectDir, source));
    const within = relative(projectDir, installedPath);
    if (within.startsWith("..") || isAbsolute(within)) continue;
    const name = basename(source).replace(/\.html$/i, "");
    const blockDir = join(registryDir, "blocks", name);
    let installed: string;
    let original: string;
    let manifest: RegistryManifest;
    try {
      installed = await readFile(installedPath, "utf8");
      manifest = JSON.parse(await readFile(join(blockDir, "registry-item.json"), "utf8")) as RegistryManifest;
      const sourceFile = manifest.files?.find((file) => file.type === "hyperframes:composition")?.path
        ?? `${name}.html`;
      original = await readFile(join(blockDir, sourceFile), "utf8");
    } catch {
      continue; // custom/user-authored sub-composition
    }

    const stock = new Set(visibleBodyText(original));
    const leftovers = visibleBodyText(installed).filter((text) => stock.has(text)).slice(0, 8);
    if (leftovers.length > 0) {
      violations.push(
        `${source}: registry block still contains stock visible copy: ` +
          `${leftovers.map((text) => JSON.stringify(text)).join(", ")}. ` +
          `Call add_registry_item again with exact textReplacements from the approved brief/script.`,
      );
    }

    const untouched = (manifest.params ?? []).filter((param) => {
      if (param.type !== "color" || typeof param.default !== "string") return false;
      const normalized = normalizeHex(param.default);
      return normalized !== null && !allowedColors.has(normalized) && hasExactHex(installed, param.default);
    });
    if (untouched.length > 0) {
      violations.push(
        `${source}: registry tunables still use catalog defaults ` +
          `${untouched.map((param) => `${param.key}=${String(param.default)}`).join(", ")}. ` +
          `Reinstall with values mapped to the DESIGN background/foreground/accent colors.`,
      );
    }
  }
  return violations;
}
