/**
 * Static design-fidelity pass over the authored composition: every color
 * literal must trace back to the design's palette (any tint/shade of a
 * palette hue, or a near-neutral), and every font-family must be one the
 * design chose. One invented teal in a warm-orange brand video reads as
 * amateur instantly — and until this check, nothing caught it: the design
 * artifact never reached the quality gate.
 *
 * Pure string/color math — no browser. Fed once into the compose fix loop.
 */
import type { Design } from "@ultracreator/shared";

interface Hsl { h: number; s: number; l: number }

/** Saturation below this is "neutral" — grays/whites/blacks always pass. */
const NEUTRAL_SAT = 0.14;
/** A color passes if its hue is within this many degrees of a palette hue. */
const HUE_TOLERANCE_DEG = 18;

function parseHex(raw: string): Hsl | null {
  let hex = raw.replace("#", "").toLowerCase();
  if (hex.length === 3 || hex.length === 4) {
    hex = [...hex].map((c) => c + c).join("");
  }
  if (hex.length !== 6 && hex.length !== 8) return null;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return rgbToHsl(r, g, b);
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** All color literals in a text: #hex plus rgb()/rgba() with numeric channels. */
function extractColors(text: string): Array<{ literal: string; hsl: Hsl }> {
  const out: Array<{ literal: string; hsl: Hsl }> = [];
  for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const hsl = parseHex(m[0]);
    if (hsl) out.push({ literal: m[0].toLowerCase(), hsl });
  }
  for (const m of text.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g)) {
    out.push({
      literal: m[0].replace(/\s+/g, "") + ")",
      hsl: rgbToHsl(Number(m[1]), Number(m[2]), Number(m[3])),
    });
  }
  return out;
}

const GENERIC_FONTS = new Set([
  "sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-sans-serif", "ui-serif", "ui-monospace", "inherit", "initial", "unset", "emoji",
]);

/** First concrete family of every font-family declaration (quotes stripped). */
function extractFontFamilies(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const stack = m[1]!.trim();
    if (stack.startsWith("var(")) continue; // palette-driven, resolved elsewhere
    const first = stack.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
    if (!first || first.startsWith("var(")) continue;
    if (GENERIC_FONTS.has(first.toLowerCase())) continue;
    out.push(first);
  }
  return out;
}

function allowedFontNames(design: Design): Set<string> {
  const names = new Set<string>();
  const add = (v: string | undefined) => {
    if (!v) return;
    // Type specs may carry sizes/weights ("Space Grotesk 700") — keep the
    // full string AND the leading family words for tolerant matching.
    names.add(v.toLowerCase().trim());
  };
  add(design.typography.heading);
  add(design.typography.body);
  return names;
}

/**
 * Violations of the design contract found in the composition's text files.
 * Returns [] when everything traces back to the design (or when there is no
 * meaningful design to check against).
 */
export function findDesignFidelityViolations(
  files: Array<{ path: string; text: string }>,
  design: Design,
): string[] {
  const paletteHexes = [
    ...design.palette.map((p) => p.hex),
    ...(design.colorRoles
      ? [design.colorRoles.background, design.colorRoles.foreground, design.colorRoles.accent,
         ...(design.colorRoles.surface ? [design.colorRoles.surface] : [])]
      : []),
  ];
  const paletteHues = paletteHexes
    .map(parseHex)
    .filter((c): c is Hsl => c !== null && c.s >= NEUTRAL_SAT)
    .map((c) => c.h);

  const fonts = allowedFontNames(design);
  const violations: string[] = [];
  const seenColorLiterals = new Set<string>();
  const seenFontNames = new Set<string>();

  for (const file of files) {
    for (const { literal, hsl } of extractColors(file.text)) {
      if (seenColorLiterals.has(literal)) continue;
      if (hsl.s < NEUTRAL_SAT) continue; // neutrals always pass
      const nearPalette = paletteHues.some((h) => hueDistance(h, hsl.h) <= HUE_TOLERANCE_DEG);
      if (nearPalette) continue;
      seenColorLiterals.add(literal);
      violations.push(
        `${file.path}: color ${literal} is not in the design palette (no palette hue within ` +
          `${HUE_TOLERANCE_DEG}°). Use a palette color (or a tint/shade of one), or set the ` +
          `component's --caption-color/--caption-accent variables to palette colors.`,
      );
    }

    for (const family of extractFontFamilies(file.text)) {
      const key = family.toLowerCase();
      if (seenFontNames.has(key)) continue;
      const allowed = [...fonts].some((f) => f.includes(key) || key.includes(f));
      if (allowed) continue;
      seenFontNames.add(key);
      violations.push(
        `${file.path}: font-family "${family}" is not the design's typography ` +
          `(heading: ${design.typography.heading}, body: ${design.typography.body}). ` +
          `Use the design fonts.`,
      );
    }
  }
  return violations;
}
