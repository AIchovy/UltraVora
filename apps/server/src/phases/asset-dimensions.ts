import sharp from "sharp";

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Pixel dimensions of an image file, or null when the file is missing or not
 * an image (the compose asset sweep also carries non-image files). The compose
 * prompt lists these so the authoring LLM — which cannot see the pixels —
 * knows each asset's aspect ratio before sizing it (session e871ba4d shipped a
 * 936×168 logo sized by height alone, 587px wider than the canvas).
 */
export async function probeImageDimensions(path: string): Promise<ImageDimensions | null> {
  try {
    const { width, height } = await sharp(path).metadata();
    if (!width || !height) return null;
    return { width, height };
  } catch {
    return null;
  }
}
