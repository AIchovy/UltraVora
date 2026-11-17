import { readFile, realpath } from "node:fs/promises";
import { extname, dirname, isAbsolute, relative, resolve } from "node:path";

export const COMMERCIAL_ICONOGRAPHY_PROMPT = `COMMERCIAL ICONOGRAPHY:
- Do not add Unicode emoji, emoticons, emoji stickers or emoji-pop captions to the
  authored video. This includes headlines, badges, feature icons and decorative layers.
  A playful product or social format does not imply an emoji treatment. Do not copy
  decorative emoji from source marketing copy into new titles or narration.
- Prefer real product details, brand assets, typography and meaningful diagrams. Use an
  icon only when it communicates something; do not put an icon beside every benefit.
- When icons are needed, use a consistent family of inline SVG paths with one stroke
  weight, corner treatment and optical size. Use the DESIGN foreground/accent colors.
  Do not use emoji fonts, text glyphs disguised as SVG text, or emoji images as substitutes.
- Preserve genuine product screenshots and logos as supplied; these rules govern new
  artwork, not retouching the product's own interface or brand assets.
- These rules override emoji examples in template/skill references. Emoji in authored
  text, CSS content or scripted labels fails the composition check and must be replaced.`;

// Do not use the broad Unicode Emoji property: it also matches ordinary digits,
// #, *, copyright/trademark marks and text arrows. Presentation sequences and
// keycaps count as emoji; normal typography and mathematical notation do not.
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[#*0-9]\uFE0F?\u20E3/u;
const segments = new Intl.Segmenter("en", { granularity: "grapheme" });
const TEXT_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".svg"]);

function codePoint(hexOrDecimal: string, radix: number): string {
  const value = parseInt(hexOrDecimal, radix);
  return value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "\uFFFD";
}

function decodeEntities(text: string): string {
  return text.replace(/&#(x[\da-f]+|\d+);?/gi, (_, value: string) =>
    /^x/i.test(value) ? codePoint(value.slice(1), 16) : codePoint(value, 10));
}

function decodeString(text: string, css: boolean): string {
  const decoded = css
    ? text.replace(/\\([\da-f]{1,6})(?:\r\n|\s)?/gi, (_, hex: string) => codePoint(hex, 16))
    : text.replace(/\\u\{([\da-f]+)\}|\\u([\da-f]{4})|\\x([\da-f]{2})/gi,
        (_, braced: string, fixed: string, byte: string) => codePoint(braced ?? fixed ?? byte, 16));
  return decodeEntities(decoded);
}

/** Quoted strings, keeping comment markers inside strings and skipping comments. */
function codeStrings(source: string, css: boolean): string[] {
  const tokens = source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g);
  return [...tokens]
    .filter((token) => !token[0].startsWith("/"))
    .map((token) => decodeString(token[0].slice(1, -1), css));
}

function authoredStrings(path: string, source: string): string[] {
  const ext = extname(path).toLowerCase();
  if (ext === ".js") return codeStrings(source, false);
  if (ext === ".css") return codeStrings(source, true);
  const strings: string[] = [];
  const markup = source.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi, (_, body: string) => {
      strings.push(...codeStrings(body, false));
      return "";
    })
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_, body: string) => {
      strings.push(...codeStrings(body, true));
      return "";
    })
    // Document metadata is not video copy. Keep <template> contents: registry
    // sub-compositions intentionally put their visible content in templates.
    .replace(/<(head|title|desc|metadata)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  for (const tag of markup.matchAll(/<[^<>]*(?:>|$)/g)) {
    const style = tag[0].match(/\bstyle\s*=\s*("[^"]*"|'[^']*')/i);
    if (style) strings.push(...codeStrings(decodeEntities(style[1]!.slice(1, -1)), true));
  }
  strings.push(decodeEntities(markup.replace(/<(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, " ")));
  return strings;
}

/** Conservative source check; raster assets and arbitrary JS execution need visual review. */
export function findIconographyViolations(files: Array<{ path: string; text: string }>): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const found = new Set<string>();
    for (const text of authoredStrings(file.path, file.text)) {
      for (const { segment } of segments.segment(text)) {
        if (EMOJI.test(segment)) found.add(segment);
      }
    }
    if (found.size) {
      violations.push(`${file.path}: authored emoji ${[...found].slice(0, 8).join(" ")}. ` +
        "Remove decorative emoji or replace meaningful icons with consistent brand-colored inline SVG paths. " +
        "Keep the surrounding copy, layout, timing and real product imagery intact; do not replace them with SVG text or emoji images.");
    }
  }
  return violations;
}

function localReferences(source: string): string[] {
  const refs: string[] = [];
  const uncommented = source.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, "");
  for (const m of uncommented.matchAll(/\b(?:data-composition-src|src|href)\s*=\s*(["'])(.*?)\1/gi)) refs.push(m[2]!);
  for (const m of uncommented.matchAll(/(?:url\(\s*|@import\s+)(["'])(.*?)\1/gi)) refs.push(m[2]!);
  for (const m of uncommented.matchAll(/url\(\s*([^\s"')]+)\s*\)/gi)) refs.push(m[1]!);
  return refs;
}

/** Scan only the current entry and reachable local sources, not old versions or unused templates. */
export async function checkCompositionIconography(projectDir: string): Promise<string[]> {
  let root: string;
  try { root = await realpath(projectDir); } catch { return []; }
  const files: Array<{ path: string; text: string }> = [];
  const visited = new Set<string>();
  const pending = [resolve(root, "index.html")];
  while (pending.length) {
    const path = pending.pop()!;
    let actual: string;
    try { actual = await realpath(path); } catch { continue; }
    const within = relative(root, actual);
    if (within.startsWith("..") || isAbsolute(within) || visited.has(actual)) continue;
    visited.add(actual);
    if (!TEXT_EXTENSIONS.has(extname(actual).toLowerCase())) continue;
    let text: string;
    try { text = await readFile(actual, "utf8"); } catch { continue; }
    files.push({ path: within, text });
    for (const ref of localReferences(text)) {
      const url = decodeEntities(ref).trim();
      if (!url || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(url)) continue;
      let decoded: string;
      try { decoded = decodeURIComponent(url.split(/[?#]/)[0]!); } catch { continue; }
      const next = resolve(dirname(actual), decoded);
      const rel = relative(root, next);
      if (!rel.startsWith("..") && !isAbsolute(rel)) pending.push(next);
    }
  }
  return findIconographyViolations(files);
}
