// apps/server/src/registry/registry-loader.ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Base directory of the vendored hyperframes registry, resolved relative to THIS
 * module (cwd-independent; works under tsx with no build step). The registry is
 * copied into the server source tree so the server is self-contained — it does
 * not depend on the (gitignored) upstream clone at the repo root.
 */
export const REGISTRY_DIR = fileURLToPath(new URL("vendor/", import.meta.url));

export type RegistryItemType = "block" | "component";

export interface RegistryCatalogEntry {
  name: string;
  type: RegistryItemType;
  title: string;
  description: string;
  tags: string[];
  /** Blocks only. */
  dimensions?: { width: number; height: number };
  /** Blocks only (seconds). */
  duration?: number;
  /** Manifest-declared customization knobs (currently mostly brand colors). */
  params?: Array<{
    key: string;
    label: string;
    type: "color" | "string" | "number" | "boolean" | "enum";
    default: unknown;
  }>;
}

/** Map a registry.json `type` to our coarse installable kind, or null to skip. */
function installableType(type: string): RegistryItemType | null {
  if (type === "hyperframes:block") return "block";
  if (type === "hyperframes:component") return "component";
  return null; // examples are not installable
}

/** Sub-directory under the registry that holds a given item type. */
export function itemDir(type: RegistryItemType, name: string): string {
  return join(REGISTRY_DIR, type === "block" ? "blocks" : "components", name);
}

/**
 * Load the catalog of installable registry items (blocks + components).
 *
 * Reads the top-level `registry.json` for the item list, then each item's
 * `registry-item.json` for its title/description/tags/dimensions. Items whose
 * manifest is missing or unreadable are skipped (logged as warnings).
 */
export async function loadRegistryCatalog(
  registryDir: string = REGISTRY_DIR,
): Promise<RegistryCatalogEntry[]> {
  const indexRaw = await readFile(join(registryDir, "registry.json"), "utf8");
  const index = JSON.parse(indexRaw) as { items?: Array<{ name: string; type: string }> };

  const entries: RegistryCatalogEntry[] = [];
  for (const ref of index.items ?? []) {
    const type = installableType(ref.type);
    if (!type) continue;
    const dir = join(registryDir, type === "block" ? "blocks" : "components", ref.name);
    try {
      const manifestRaw = await readFile(join(dir, "registry-item.json"), "utf8");
      const m = JSON.parse(manifestRaw) as {
        title?: string;
        description?: string;
        tags?: string[];
        dimensions?: { width: number; height: number };
        duration?: number;
        params?: RegistryCatalogEntry["params"];
      };
      entries.push({
        name: ref.name,
        type,
        title: m.title ?? ref.name,
        description: m.description ?? "",
        tags: m.tags ?? [],
        ...(m.dimensions ? { dimensions: m.dimensions } : {}),
        ...(typeof m.duration === "number" ? { duration: m.duration } : {}),
        ...(m.params?.length ? { params: m.params } : {}),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[registry-loader] skipping "${ref.name}": ${(err as Error).message}`);
    }
  }
  return entries;
}

type Orientation = "landscape" | "portrait" | "square";

function orientationOf(width: number, height: number): Orientation {
  if (width > height) return "landscape";
  if (width < height) return "portrait";
  return "square";
}

/**
 * Render the catalog as a compact block for the compose system prompt. Mirrors
 * the skills listing: enough for the model to choose an item, not the full files.
 *
 * When the composition's resolution is given, blocks whose orientation
 * mismatches are dropped — 60/64 blocks are 1920×1080, and on a 9:16 video a
 * landscape sub-composition letterboxes badly, so listing them is pure
 * distraction. Dimension-less components always stay.
 */
export function formatRegistryCatalogForPrompt(
  entries: RegistryCatalogEntry[],
  resolution?: { width: number; height: number },
): string {
  const targetOrientation = resolution
    ? orientationOf(resolution.width, resolution.height)
    : null;
  const usable = entries.filter((e) => {
    if (e.type !== "block" || !e.dimensions || !targetOrientation) return true;
    return orientationOf(e.dimensions.width, e.dimensions.height) === targetOrientation;
  });
  const blocks = usable.filter((e) => e.type === "block");
  const components = usable.filter((e) => e.type === "component");

  const line = (e: RegistryCatalogEntry): string => {
    const meta = e.type === "block" && e.dimensions
      ? ` [${e.dimensions.width}x${e.dimensions.height}, ${e.duration ?? "?"}s]`
      : "";
    const tags = e.tags.length ? ` (${e.tags.join(", ")})` : "";
    // Showcase entries are self-branded demo pages, not drop-in items —
    // embedding one wholesale ships the demo's own copy and branding.
    const showcaseNote = e.tags.includes("showcase")
      ? " [showcase demo — study the effect and recreate it; don't embed as-is]"
      : "";
    return `  - ${e.name}${meta}: ${e.description}${tags}${showcaseNote}`;
  };

  return [
    "The following hyperframes registry items can be installed with the add_registry_item tool.",
    "Blocks are standalone sub-compositions you wire into index.html via data-composition-src.",
    "Components are effect snippets you merge into a composition. Read the hyperframes-registry",
    "skill for wiring rules before using either.",
    "",
    "<registry_blocks>",
    ...blocks.map(line),
    "</registry_blocks>",
    "",
    "<registry_components>",
    ...components.map(line),
    "</registry_components>",
  ].join("\n");
}
