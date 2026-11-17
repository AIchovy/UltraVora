import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCompositionIconography, findIconographyViolations } from "../src/render/iconography-check.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const check = (text: string, path = "index.html") => findIconographyViolations([{ path, text }]);

describe("commercial iconography source check", () => {
  it("catches emoji added to real promo benefit lines", () => {
    const issues = check('<span>🎯</span> 100% Native cross-platform export\n<span>✨</span> Agency fidelity');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("🎯");
    expect(issues[0]).toContain("✨");
    expect(issues[0]).toContain("SVG paths");
  });

  it("decodes HTML numeric entities including missing semicolons", () => {
    expect(check('<span>&#128640; &#x2728; &#x1f525</span>')[0]).toContain("🚀 ✨ 🔥");
  });

  it("detects flags, skin-tone/ZWJ sequences and keycaps as complete glyphs", () => {
    const issue = check('<div>🇨🇳 👩🏽‍💻 1️⃣ ❤️</div>')[0];
    for (const glyph of ["🇨🇳", "👩🏽‍💻", "1️⃣", "❤️"]) expect(issue).toContain(glyph);
  });

  it("preserves ordinary international text, numbers, symbols and SVG paths", () => {
    expect(check('<div>中文 · Français — © 2026 ACME®™ → ↔ ✓ + − × #1 * 99%</div><svg><path d="M2 12l6 6L22 2"/></svg>')).toEqual([]);
  });

  it("ignores comments, document metadata and original product asset filenames", () => {
    expect(check('<head><title>🚀 Launch</title></head><!-- ✨ -->' +
      '<img src="product-🚀.png" alt="🚀 Original product"/><script>// 🔥\n/* 🎯 */ const title = "Launch";</script>' +
      '<style>/* ✅ */ .title { color: white }</style>')).toEqual([]);
  });

  it("checks template and SVG text rather than treating SVG text as an icon replacement", () => {
    expect(check('<template><svg><text>🔥</text></svg></template>')).toHaveLength(1);
    expect(check('<svg><title>🔥</title><path d="M0 0"/></svg>', "icon.svg")).toEqual([]);
  });

  it("catches JavaScript literals and Unicode escapes without executing the script", () => {
    const source = String.raw`<script>
      const labels = ["🚀", '\u{1F525}', "\uD83D\uDE80"];
      document.querySelector('.badge').textContent = labels[0];
    </script>`;
    const issue = check(source)[0];
    expect(issue).toContain("🚀 🔥");
    expect(check(String.raw`node.textContent = "\u{2728}"`, "labels.js")[0]).toContain("✨");
  });

  it("checks CSS generated content, including escaped and inline styles", () => {
    expect(check(String.raw`.badge::before { content: "\1f680 " }`, "style.css")[0]).toContain("🚀");
    expect(check(String.raw`<style>.badge::after { content: '\2728' }</style>`)[0]).toContain("✨");
    expect(check(`<span style="--icon: '🔥'">Launch</span>`)[0]).toContain("🔥");
  });

  it("does not throw on invalid encoded Unicode", () => {
    expect(check('<div>&#x110000;</div>')).toEqual([]);
  });
});

describe("current composition dependencies", () => {
  it("checks referenced nested sources, not old snapshots, unused files or outside paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "uc-icons-")); roots.push(root);
    const project = join(root, "composition");
    await mkdir(join(project, "scenes"), { recursive: true });
    await writeFile(join(root, "outside.html"), '<p>🚫</p>');
    await symlink(join(root, "outside.html"), join(project, "outside.html"));
    await writeFile(join(project, "index.html"), `
      <div data-composition-src="scenes/hero.html"></div>
      <div data-composition-src="../outside.html"></div>
      <div data-composition-src="outside.html"></div>
      <script src="https://example.com/runtime.js"></script>`);
    await writeFile(join(project, "scenes", "hero.html"), `
      <template><span>🎯 Product</span></template>
      <link rel="stylesheet" href="hero.css"><script src="labels.js"></script>
      <img src="icon.svg"><div data-composition-src="../index.html"></div>`);
    await writeFile(join(project, "scenes", "hero.css"), '.badge::before{content:"✨"}');
    await writeFile(join(project, "scenes", "labels.js"), String.raw`badge.textContent = "\u{1f525}"`);
    await writeFile(join(project, "scenes", "icon.svg"), '<svg><text>✅</text></svg>');
    await writeFile(join(project, "index.v1.html"), '<p>🚫 Old version</p>');
    await writeFile(join(project, "unused.html"), '<p>🚫 Unused template</p>');
    const issues = await checkCompositionIconography(project);
    expect(issues).toHaveLength(4);
    for (const file of ["hero.html", "hero.css", "labels.js", "icon.svg"]) {
      expect(issues.some((issue) => issue.startsWith(`scenes/${file}:`))).toBe(true);
    }
    expect(issues.join("\n")).not.toContain("🚫");
  });
});
