// Resolution map now lives in @ultracreator/shared (so the web can show it too);
// re-exported here for the existing server import sites.
export { RESOLUTIONS } from "@ultracreator/shared";

/**
 * Validate a hex color literal for safe interpolation into a CSS context.
 * Accepts exactly `#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA`.
 */
export function assertHexColor(hex: string): string {
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return hex;
}

/**
 * Validate a font-family name for safe interpolation inside a CSS `font-family`
 * literal. Allows only letters, digits, spaces, hyphens, and underscores.
 */
export function assertCssFontFamily(font: string): string {
  if (!/^[A-Za-z0-9 _-]+$/.test(font)) {
    throw new Error(`Invalid font name: ${font}`);
  }
  return font;
}
