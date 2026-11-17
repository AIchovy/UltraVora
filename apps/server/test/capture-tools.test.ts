import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { makeCaptureWebsiteTool } from "../src/tools/capture-tools.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-capture-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const PASS = ["node", "-e", "process.exit(0)"];
const FAIL = ["node", "-e", "console.error('chrome exploded'); process.exit(1)"];

async function seedCaptureDir(wsRoot: string): Promise<void> {
  const cap = join(wsRoot, "capture");
  await mkdir(join(cap, "extracted"), { recursive: true });
  await mkdir(join(cap, "assets", "svgs"), { recursive: true });
  await mkdir(join(cap, "screenshots"), { recursive: true });
  await writeFile(
    join(cap, "extracted", "tokens.json"),
    JSON.stringify({
      title: "Acme — ship faster",
      description: "Dev tools",
      colors: ["#0a0a14", "#f5f5f7", "#ff4757"],
      fonts: [{ family: "Space Grotesk", weights: [400, 700] }],
      headings: [{ level: 1, text: "Ship faster", fontSize: "64px", color: "#f5f5f7" }],
    }),
  );
  await writeFile(join(cap, "extracted", "visible-text.txt"), "[h1] Ship faster\n[p] Acme is dev tooling.");
  await writeFile(join(cap, "assets", "hero.png"), "png-bytes");
  await writeFile(join(cap, "assets", "svgs", "logo.svg"), "<svg/>");
  const shot = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 10, g: 10, b: 20 } } })
    .jpeg().toBuffer();
  await writeFile(join(cap, "screenshots", "screenshot-01.jpg"), shot);
  await writeFile(join(cap, "screenshots", "contact-sheet-1.jpg"), shot);
}

describe("capture_website tool", () => {
  it("summarizes tokens, lists assets workspace-relative, and attaches screenshots", async () => {
    const workspaces = new WorkspaceManager(root);
    await workspaces.init("s1");
    await seedCaptureDir(workspaces.paths("s1").root);

    const tool = makeCaptureWebsiteTool({
      sessionId: "s1",
      workspaces,
      commandFor: () => [...PASS],
    });
    const result = await tool.execute("c1", { url: "https://acme.dev" });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("#0a0a14");
    expect(text).toContain("Space Grotesk");
    expect(text).toContain("capture/assets/hero.png");
    expect(text).toContain("capture/assets/svgs/logo.svg");
    expect(text).toContain("Ship faster");

    const images = result.content.filter((c) => c.type === "image");
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect((images[0] as { mimeType: string }).mimeType).toBe("image/jpeg");

    expect(result.details).toMatchObject({
      colors: ["#0a0a14", "#f5f5f7", "#ff4757"],
      fonts: ["Space Grotesk"],
    });
  });

  it("throws with a fallback hint when the capture command fails", async () => {
    const workspaces = new WorkspaceManager(root);
    await workspaces.init("s1");
    const tool = makeCaptureWebsiteTool({
      sessionId: "s1",
      workspaces,
      commandFor: () => [...FAIL],
    });
    await expect(tool.execute("c1", { url: "https://acme.dev" })).rejects.toThrow(/web_fetch/);
  });

  it("rejects non-http(s) URLs without spawning", async () => {
    const workspaces = new WorkspaceManager(root);
    await workspaces.init("s1");
    const tool = makeCaptureWebsiteTool({
      sessionId: "s1",
      workspaces,
      commandFor: () => { throw new Error("should not spawn"); },
    });
    await expect(tool.execute("c1", { url: "file:///etc/passwd" })).rejects.toThrow(/scheme/);
  });
});
