import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { imageContentFromFile, dominantHexes } from "../src/tools/image-content.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-imgc-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function pngOf(width: number, height: number, rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: rgb } }).png().toBuffer();
}

describe("imageContentFromFile", () => {
  it("returns a base64 image block, downscaled to the max dimension", async () => {
    const p = join(root, "big.png");
    await writeFile(p, await pngOf(2000, 1000, { r: 200, g: 30, b: 40 }));
    const block = await imageContentFromFile(p, { maxDim: 500 });
    expect(block).not.toBeNull();
    expect(block!.type).toBe("image");
    expect(block!.mimeType).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(block!.data, "base64")).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(500);
  });

  it("returns null for unreadable or non-image files", async () => {
    const p = join(root, "not-an-image.txt");
    await writeFile(p, "hello");
    expect(await imageContentFromFile(p)).toBeNull();
    expect(await imageContentFromFile(join(root, "missing.png"))).toBeNull();
  });
});

describe("dominantHexes", () => {
  it("finds the dominant colors of a two-tone image", async () => {
    // Left half red, right half blue.
    const left = await pngOf(50, 100, { r: 220, g: 20, b: 20 });
    const right = await pngOf(50, 100, { r: 20, g: 20, b: 220 });
    const img = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .composite([
        { input: left, left: 0, top: 0 },
        { input: right, left: 50, top: 0 },
      ])
      .png()
      .toBuffer();
    const hexes = await dominantHexes(img, 2);
    expect(hexes).toHaveLength(2);
    // One reddish, one blueish (order by frequency; both halves equal so accept either order).
    const joined = hexes.join(" ").toLowerCase();
    expect(joined).toMatch(/#[c-f][0-9a-f][0-2][0-9a-f][0-2][0-9a-f]/); // reddish
    expect(joined).toMatch(/#[0-2][0-9a-f][0-2][0-9a-f][c-f][0-9a-f]/); // blueish
  });

  it("returns [] for undecodable bytes", async () => {
    expect(await dominantHexes(Buffer.from("nope"), 3)).toEqual([]);
  });
});
