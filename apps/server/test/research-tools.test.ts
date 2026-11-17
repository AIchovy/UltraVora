import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { makeWebFetchTool, makeReadUploadTool } from "../src/tools/research-tools.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-rtools-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("web_fetch tool", () => {
  it("returns the fetched body as text content", async () => {
    const tool = makeWebFetchTool({
      fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
    });
    const result = await tool.execute("call-1", { url: "https://example.com" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "body of https://example.com" });
    expect(result.details).toMatchObject({ url: "https://example.com", status: 200 });
  });

  it("throws on non-2xx responses", async () => {
    const tool = makeWebFetchTool({
      fetch: async () => ({ status: 404, text: "not found" }),
    });
    await expect(tool.execute("call-1", { url: "https://x" })).rejects.toThrow(/404/);
  });

  it("rejects non-http(s) urls", async () => {
    const tool = makeWebFetchTool({ fetch: async () => ({ status: 200, text: "" }) });
    await expect(tool.execute("call-1", { url: "file:///etc/passwd" })).rejects.toThrow(/scheme/i);
  });
});

describe("read_upload tool", () => {
  it("reads a file from the session's uploads directory", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const p = wm.paths("s1");
    writeFileSync(join(p.uploads, "notes.txt"), "hello upload");
    const tool = makeReadUploadTool({ sessionId: "s1", workspaces: wm });
    const result = await tool.execute("call-1", { filename: "notes.txt" });
    expect((result.content[0] as { text: string }).text).toBe("hello upload");
  });

  it("rejects path-traversal filenames", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const tool = makeReadUploadTool({ sessionId: "s1", workspaces: wm });
    await expect(tool.execute("call-1", { filename: "../../etc/passwd" })).rejects.toThrow(/invalid filename/i);
  });

  it("throws when the file does not exist", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const tool = makeReadUploadTool({ sessionId: "s1", workspaces: wm });
    await expect(tool.execute("call-1", { filename: "missing.txt" })).rejects.toThrow();
  });

  it("returns uploaded images as an image block instead of mojibake text", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const p = wm.paths("s1");
    const png = await sharp({
      create: { width: 60, height: 60, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).png().toBuffer();
    writeFileSync(join(p.uploads, "logo.png"), png);
    const tool = makeReadUploadTool({ sessionId: "s1", workspaces: wm });
    const result = await tool.execute("call-1", { filename: "logo.png" });
    const image = result.content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    // No raw binary dumped as text.
    const texts = result.content.filter((c) => c.type === "text") as { text: string }[];
    for (const t of texts) expect(t.text).not.toContain("�");
  });
});
