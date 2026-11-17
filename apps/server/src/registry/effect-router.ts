import type { Design, Script } from "@ultracreator/shared";
import type { RegistryCatalogEntry } from "./registry-loader.js";

export interface EffectRecommendation {
  entry: RegistryCatalogEntry;
  score: number;
  reason: string;
}

const STOP_WORDS = new Set([
  "and", "the", "with", "from", "into", "scene", "effect", "video", "transition",
  "background", "foreground", "midground", "reveal", "style", "motion", "visual",
]);

const SYNONYMS: Record<string, string[]> = {
  app: ["device", "iphone", "macbook", "ui", "screen", "product"],
  premium: ["shimmer", "vignette", "grain", "cinematic", "glass"],
  luxury: ["shimmer", "vignette", "grain", "cinematic", "glass"],
  tech: ["glitch", "matrix", "chromatic", "device", "ui", "webgl"],
  social: ["instagram", "tiktok", "youtube", "twitter", "reddit", "post"],
  data: ["chart", "statistics", "map", "counter"],
  organic: ["grain", "liquid", "texture", "ripple"],
  editorial: ["editorial", "typography", "grain", "vignette"],
  energetic: ["kinetic", "slam", "glitch", "burst", "whoosh"],
};

const HAN_INTENTS: Array<[string, string[]]> = [
  ["手机", ["iphone", "device", "ui"]], ["设备", ["device", "3d"]],
  ["产品", ["product", "device"]], ["玻璃", ["glass", "liquid"]],
  ["液态", ["liquid", "glass"]], ["故障", ["glitch", "chromatic"]],
  ["科技", ["tech", "glitch", "device"]], ["高端", ["premium", "cinematic"]],
  ["奢华", ["luxury", "shimmer", "cinematic"]], ["电影", ["cinematic", "vignette"]],
  ["社交", ["social", "post"]], ["数据", ["data", "chart"]],
  ["图表", ["chart", "statistics"]], ["地图", ["map", "geography"]],
  ["文字", ["text", "typography", "caption"]], ["字幕", ["caption", "text"]],
  ["颗粒", ["grain", "texture"]], ["纹理", ["texture", "mask"]],
  ["辉光", ["glow", "shimmer"]], ["闪光", ["light", "shimmer"]],
  ["缩放", ["zoom", "scale"]], ["冲击", ["slam", "burst", "kinetic"]],
];

function orientation(width: number, height: number): "landscape" | "portrait" | "square" {
  return width === height ? "square" : width > height ? "landscape" : "portrait";
}

function words(value: string): Set<string> {
  const tokens = value.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? [];
  const expanded = new Set(tokens.filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
  for (const token of [...expanded]) {
    for (const synonym of SYNONYMS[token] ?? []) expanded.add(synonym);
  }
  for (const [phrase, synonyms] of HAN_INTENTS) {
    if (value.includes(phrase)) synonyms.forEach((synonym) => expanded.add(synonym));
  }
  return expanded;
}

/**
 * Turn the director plan into a short, intentional registry shortlist. The old
 * behavior dumped the whole catalog into the authoring prompt, which made the
 * useful templates effectively invisible and encouraged arbitrary choices.
 */
export function recommendRegistryEffects(
  entries: RegistryCatalogEntry[],
  script: Script,
  design: Design,
  resolution?: { width: number; height: number },
  limit = 12,
): EffectRecommendation[] {
  const planText = script.productionPlan ? JSON.stringify(script.productionPlan) : "";
  const source = [
    design.mood,
    design.motionStyle,
    design.imageStyle ?? "",
    ...script.scenes.flatMap((scene) => [scene.visual, scene.onScreenText ?? ""]),
    planText,
  ].join(" ");
  const intent = words(source);
  const targetOrientation = resolution ? orientation(resolution.width, resolution.height) : null;

  return entries
    .filter((entry) => !entry.tags.includes("showcase"))
    .filter((entry) => !/emoji/i.test(entry.name) && !entry.tags.some((tag) => /emoji/i.test(tag)))
    .filter((entry) => {
      if (entry.type !== "block" || !entry.dimensions || !targetOrientation) return true;
      return orientation(entry.dimensions.width, entry.dimensions.height) === targetOrientation;
    })
    .map((entry) => {
      const haystack = words([entry.name, entry.title, entry.description, ...entry.tags].join(" "));
      const matches = [...intent].filter((token) => haystack.has(token));
      let score = matches.length * 3;
      // Small reusable finishing components are safe defaults; standalone
      // blocks need a real semantic match before they enter the shortlist.
      if (entry.type === "component") score += 1;
      if (["grain-overlay", "vignette"].includes(entry.name)) score += 2;
      if (entry.type === "block" && matches.length === 0) score -= 10;
      return {
        entry,
        score,
        reason: matches.length
          ? `matches director/design intent: ${matches.slice(0, 4).join(", ")}`
          : "reusable finishing layer",
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit);
}

export function formatEffectRecommendationsForPrompt(
  recommendations: EffectRecommendation[],
  script: Script,
): string {
  const requested = script.productionPlan?.scenes
    .filter((scene) => scene.effectSlots.length > 0)
    .map((scene) => `  - ${scene.sceneId}: ${scene.effectSlots.join("; ")}`) ?? [];
  const lines = recommendations.map(({ entry, reason }) => {
    const dimensions = entry.type === "block" && entry.dimensions
      ? ` [${entry.dimensions.width}x${entry.dimensions.height}, up to ${entry.duration ?? "?"}s]`
      : "";
    const params = entry.params?.length
      ? `; tunables: ${entry.params.map((param) => `${param.key}=${String(param.default)}`).join(", ")}`
      : "";
    return `  - ${entry.name} (${entry.type})${dimensions}: ${entry.description}${params} — ${reason}`;
  });
  return [
    "<effect_route>",
    "The director requested these effect moments:",
    ...(requested.length ? requested : ["  - No explicit slots (use restrained finishing only)."]),
    "",
    "Registry shortlist selected for this exact storyboard:",
    ...(lines.length ? lines : ["  - No registry item is a strong match; author the effect directly."]),
    "",
    "Use add_registry_item for a shortlisted item when it materially improves the named beat.",
    "Pass values for declared tunables so the installed source uses the DESIGN palette. For a block",
    "with stock copy, install once to inspect the returned visible-text candidates, then call it again",
    "with exact textReplacements before wiring. Never ship stock demo copy, branding or SCENE A/B.",
    "Do not browse or install unrelated catalog items just to add spectacle.",
    "</effect_route>",
  ].join("\n");
}
