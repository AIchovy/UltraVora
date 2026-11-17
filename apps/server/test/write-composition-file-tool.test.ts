import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { makeWriteCompositionFileTool } from "../src/tools/composition-tools.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-wcf-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const signal = new AbortController().signal;

function setup() {
  const wm = new WorkspaceManager(root);
  return { wm, tool: makeWriteCompositionFileTool({ sessionId: "s1", workspaces: wm }) };
}

describe("makeWriteCompositionFileTool", () => {
  it("writes index.html into composition/", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    await tool.execute("c1", { path: "index.html", content: "<html>hi</html>" }, signal);
    const abs = join(wm.paths("s1").composition, "index.html");
    expect(readFileSync(abs, "utf8")).toBe("<html>hi</html>");
  });

  it("creates parent dirs for a shallow subpath", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    await tool.execute("c1", { path: "scenes/s1.html", content: "x" }, signal);
    expect(existsSync(join(wm.paths("s1").composition, "scenes", "s1.html"))).toBe(true);
  });

  it("rejects an absolute path", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    await expect(tool.execute("c1", { path: "/etc/passwd", content: "x" }, signal)).rejects.toThrow(/path/i);
  });

  it("rejects a parent-escape path", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    await expect(tool.execute("c1", { path: "../artifacts/x.json", content: "x" }, signal)).rejects.toThrow(/path/i);
  });

  it("strips cache-buster query strings from local asset refs in HTML", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    const html =
      `<img src="logo.png?v=2"><img src='hero.png?123'>` +
      `<link href="style.css?build=9">`;
    await tool.execute("c1", { path: "index.html", content: html }, signal);
    const out = readFileSync(join(wm.paths("s1").composition, "index.html"), "utf8");
    expect(out).toContain('src="logo.png"');
    expect(out).toContain("src='hero.png'");
    expect(out).toContain('href="style.css"');
    expect(out).not.toContain("?v=2");
    expect(out).not.toContain("?123");
    expect(out).not.toContain("?build=9");
  });

  it("leaves absolute http(s) URLs (with their query strings) untouched", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    const html =
      `<script src="https://cdn.example.com/gsap.min.js?ver=3.12"></script>` +
      `<source src="https://x.com/a.mp4?token=abc">`;
    await tool.execute("c1", { path: "index.html", content: html }, signal);
    const out = readFileSync(join(wm.paths("s1").composition, "index.html"), "utf8");
    expect(out).toContain("https://cdn.example.com/gsap.min.js?ver=3.12");
    expect(out).toContain("https://x.com/a.mp4?token=abc");
  });

  it("preserves a #fragment after stripping a local query string", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    await tool.execute("c1", { path: "index.html", content: `<img src="sprite.svg?v=2#icon">` }, signal);
    const out = readFileSync(join(wm.paths("s1").composition, "index.html"), "utf8");
    expect(out).toContain('src="sprite.svg#icon"');
  });

  it("strips local query strings inside CSS url() but not data: URIs", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    const css = `.a{background:url("bg.png?v=2")} .b{background:url(data:image/png;base64,AAAA)}`;
    await tool.execute("c1", { path: "style.css", content: css }, signal);
    const out = readFileSync(join(wm.paths("s1").composition, "style.css"), "utf8");
    expect(out).toContain('url("bg.png")');
    expect(out).toContain("url(data:image/png;base64,AAAA)");
  });

  it("does not alter content of non-HTML/CSS files", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    const js = `const u = "foo.png?v=2";`;
    await tool.execute("c1", { path: "data.js", content: js }, signal);
    const out = readFileSync(join(wm.paths("s1").composition, "data.js"), "utf8");
    expect(out).toBe(js);
  });
});
