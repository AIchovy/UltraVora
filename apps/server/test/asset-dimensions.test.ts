import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { probeImageDimensions } from "../src/phases/asset-dimensions.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "uc-dims-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function makeImage(name: string, width: number, height: number, format: "png" | "jpeg") {
  const path = join(dir, name);
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 250, g: 210, b: 70 } },
  });
  await (format === "png" ? image.png() : image.jpeg()).toFile(path);
  return path;
}

describe("probeImageDimensions", () => {
  it("reads the pixel size of a wide PNG lockup", async () => {
    const path = await makeImage("logo.png", 936, 168, "png");
    expect(await probeImageDimensions(path)).toEqual({ width: 936, height: 168 });
  });

  it("reads JPEG dimensions", async () => {
    const path = await makeImage("photo.jpg", 64, 32, "jpeg");
    expect(await probeImageDimensions(path)).toEqual({ width: 64, height: 32 });
  });

  it("returns null for a non-image file", async () => {
    const path = join(dir, "narration.wav");
    await writeFile(path, Buffer.from("RIFF....WAVEfmt ", "ascii"));
    expect(await probeImageDimensions(path)).toBeNull();
  });

  it("returns null for a missing file", async () => {
    expect(await probeImageDimensions(join(dir, "nope.png"))).toBeNull();
  });
});
