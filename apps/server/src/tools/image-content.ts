// apps/server/src/tools/image-content.ts
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { ImageContent } from "@earendil-works/pi-ai";

/**
 * Images that compress to almost nothing per pixel are flat colours or smooth
 * decorative gradients (hero banners, spacers, blurred overlays) with no real
 * subject — exactly the kind of asset that should never become a scene's focal
 * image. Measured on real downloads: a blank gradient sat at ~0.003 bytes/pixel
 * while the lowest-detail genuine asset (a logo) was ~0.087, so 0.02 sits in a
 * wide safe gap and never flags logos/icons/screenshots. SVG (vector, no raster
 * dimensions) and undecodable bytes are left unflagged.
 */
export const LOW_CONTENT_BYTES_PER_PIXEL = 0.02;

export async function isLowContentImage(bytes: Buffer): Promise<boolean> {
  try {
    const meta = await sharp(bytes).metadata();
    const pixels = (meta.width ?? 0) * (meta.height ?? 0);
    if (pixels <= 0) return false;
    return bytes.byteLength / pixels < LOW_CONTENT_BYTES_PER_PIXEL;
  } catch {
    // Not a raster image we can measure (e.g. SVG) — don't flag.
    return false;
  }
}

export interface ImageContentOptions {
  /** Longest edge of the returned image. Default 1024. */
  maxDim?: number;
  /** JPEG quality. Default 72. */
  quality?: number;
}

/**
 * Load an image file as a pi-ai ImageContent block (downscaled JPEG) so a
 * multimodal model can actually SEE it. Returns null for unreadable or
 * non-image files — callers treat the image as a best-effort attachment,
 * never a reason to fail.
 */
export async function imageContentFromFile(
  path: string,
  opts: ImageContentOptions = {},
): Promise<ImageContent | null> {
  const maxDim = opts.maxDim ?? 1024;
  const quality = opts.quality ?? 72;
  try {
    const bytes = await readFile(path);
    const jpeg = await sharp(bytes)
      // flatten: JPEG has no alpha; transparent logos composite onto white.
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize(maxDim, maxDim, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    return { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

/**
 * The N most frequent colors of an image, as hex strings ordered by coverage.
 * Coarse 32-per-channel binning over a 64px thumbnail — meant to name a
 * logo's brand colors, not to be a precise palette extractor. Fully
 * transparent pixels are ignored. Returns [] for undecodable bytes.
 */
export async function dominantHexes(bytes: Buffer, n: number): Promise<string[]> {
  try {
    const { data, info } = await sharp(bytes)
      .resize(64, 64, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const counts = new Map<number, number>();
    for (let i = 0; i + 3 < data.length; i += info.channels) {
      const a = data[i + 3]!;
      if (a < 128) continue; // ignore transparent pixels
      // 5 bits per channel → 32 levels; enough to separate brand colors.
      const key = ((data[i]! >> 3) << 10) | ((data[i + 1]! >> 3) << 5) | (data[i + 2]! >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const toHex = (key: number): string => {
      // Re-center each 5-bit bin to its midpoint.
      const r = ((key >> 10) & 31) * 8 + 4;
      const g = ((key >> 5) & 31) * 8 + 4;
      const b = (key & 31) * 8 + 4;
      return `#${[r, g, b].map((v) => Math.min(255, v).toString(16).padStart(2, "0")).join("")}`;
    };
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key]) => toHex(key));
  } catch {
    return [];
  }
}
