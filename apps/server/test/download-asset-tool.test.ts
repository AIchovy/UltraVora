import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { makeDownloadAssetTool } from "../src/tools/research-tools.js";

/** A large flat-colour image — compresses to almost nothing (very low bytes/pixel),
 *  the signature of a decorative banner / blank gradient like the one that shipped
 *  as a scene's focal "product" image. */
async function flatImageBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 2000, height: 1000, channels: 3, background: { r: 255, g: 211, b: 71 } },
  })
    .webp()
    .toBuffer();
}

/** Incompressible noise — high bytes/pixel, the signature of a real screenshot/photo. */
async function noiseImageBytes(): Promise<Buffer> {
  const w = 600;
  const h = 600;
  return sharp(randomBytes(w * h * 3), { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-da-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const PNG = Buffer.from("89504e470d0a1a0a", "hex"); // PNG magic bytes
const signal = new AbortController().signal;

function setup(fetchBinary: any) {
  const wm = new WorkspaceManager(root);
  return { wm, tool: makeDownloadAssetTool({ sessionId: "s1", workspaces: wm, fetchBinary }) };
}

describe("makeDownloadAssetTool", () => {
  it("attaches the downloaded image as an image block plus its dominant colors", async () => {
    const bytes = await sharp({
      create: { width: 400, height: 200, channels: 3, background: { r: 220, g: 20, b: 20 } },
    }).png().toBuffer();
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "image/png", bytes }));
    await wm.init("s1");
    const result = await tool.execute("c1", { url: "https://x.test/logo.png" });
    // First block stays the bare path (parsers rely on it)…
    expect((result.content[0] as { text: string }).text).toMatch(/^assets\//);
    // …an image block lets the model SEE what it grabbed…
    const image = result.content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    // …and a text block names the dominant colors for brand extraction.
    const colorLine = result.content.find(
      (c) => c.type === "text" && /dominant colors/i.test((c as { text: string }).text),
    ) as { text: string } | undefined;
    expect(colorLine).toBeDefined();
    expect(colorLine!.text.toLowerCase()).toMatch(/#[0-9a-f]{6}/);
  });

  it("accepts favicon .ico content-types", async () => {
    const { wm, tool } = setup(async () => ({
      status: 200,
      contentType: "image/x-icon",
      bytes: Buffer.from("00000100", "hex"),
    }));
    await wm.init("s1");
    const result = await tool.execute("c1", { url: "https://x.test/favicon.ico" });
    expect((result.content[0] as { text: string }).text).toMatch(/^assets\/.*\.ico$/);
  });

  it("writes an allowed image under assets/ and returns its local path", async () => {
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "image/png", bytes: PNG }));
    await wm.init("s1");
    const res = await tool.execute("c1", { url: "https://x.com/logo.png" }, signal);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^assets\/[0-9a-f]+\.png$/);
    expect(existsSync(join(wm.paths("s1").assets, text.replace("assets/", "")))).toBe(true);
    expect(res.details).toMatchObject({ contentType: "image/png" });
  });

  it("rejects a disallowed content-type", async () => {
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "text/html", bytes: PNG }));
    await wm.init("s1");
    await expect(tool.execute("c1", { url: "https://x.com/page" }, signal)).rejects.toThrow(/content-type/i);
  });

  it("rejects an oversized body", async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 1);
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "image/png", bytes: big }));
    await wm.init("s1");
    await expect(tool.execute("c1", { url: "https://x.com/big.png" }, signal)).rejects.toThrow(/size|large/i);
  });

  it("rejects a non-http(s) scheme", async () => {
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "image/png", bytes: PNG }));
    await wm.init("s1");
    await expect(tool.execute("c1", { url: "file:///etc/passwd" }, signal)).rejects.toThrow(/scheme/i);
  });

  it("rejects a non-2xx status", async () => {
    const { wm, tool } = setup(async () => ({ status: 404, contentType: "image/png", bytes: PNG }));
    await wm.init("s1");
    await expect(tool.execute("c1", { url: "https://x.com/missing.png" }, signal)).rejects.toThrow(/404|failed/i);
  });

  it("flags a near-blank/decorative image as lowContent and warns", async () => {
    const bytes = await flatImageBytes();
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "image/webp", bytes }));
    await wm.init("s1");
    const res = await tool.execute("c1", { url: "https://x.com/hero-banner.webp" }, signal);
    // The path must still be the first content block so callers parse it unchanged.
    expect((res.content[0] as { text: string }).text).toMatch(/^assets\/[0-9a-f]+\.webp$/);
    expect(res.details).toMatchObject({ lowContent: true });
    const joined = res.content.map((c) => (c as { text: string }).text).join("\n");
    expect(joined).toMatch(/near-blank|decorative|background|focal/i);
  });

  it("does not flag a content-rich image", async () => {
    const bytes = await noiseImageBytes();
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "image/png", bytes }));
    await wm.init("s1");
    const res = await tool.execute("c1", { url: "https://x.com/screenshot.png" }, signal);
    expect(res.details).toMatchObject({ lowContent: false });
    // No near-blank warning — only the path, the image preview, and colors.
    const texts = res.content.filter((c) => c.type === "text") as { text: string }[];
    expect(texts.map((t) => t.text).join("\n")).not.toMatch(/near-blank/i);
  });

  it("does not write more than one file per identical download", async () => {
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "image/png", bytes: PNG }));
    await wm.init("s1");
    await tool.execute("c1", { url: "https://x.com/logo.png" }, signal);
    await tool.execute("c2", { url: "https://x.com/logo.png" }, signal);
    expect(readdirSync(wm.paths("s1").assets).length).toBe(1); // same hash → same filename
  });
});
