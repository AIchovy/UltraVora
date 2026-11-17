// apps/server/test/add-registry-item.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { makeAddRegistryItemTool } from "../src/tools/add-registry-item-tool.js";

let root: string;
let wm: WorkspaceManager;
const SID = "s1";

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-reg-"));
  wm = new WorkspaceManager(root);
  await wm.init(SID);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("add_registry_item tool (vendored registry)", () => {
  it("installs a block and returns its wiring snippet", async () => {
    const tool = makeAddRegistryItemTool({ sessionId: SID, workspaces: wm });
    const res = await tool.execute("c1", { name: "macos-notification" });

    const comp = wm.paths(SID).composition;
    expect(existsSync(join(comp, "macos-notification.html"))).toBe(true);

    expect(res.details).toMatchObject({
      kind: "block",
      compositionId: "macos-notification",
      src: "macos-notification.html",
      width: 1920,
      height: 1080,
      duration: 5,
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('data-composition-src="macos-notification.html"');
    expect(text).toContain('data-composition-id="macos-notification"');
  });

  it("installs a component and returns its snippet contents to merge", async () => {
    const tool = makeAddRegistryItemTool({ sessionId: SID, workspaces: wm });
    const res = await tool.execute("c2", { name: "caption-clip-wipe" });

    const comp = wm.paths(SID).composition;
    expect(existsSync(join(comp, "components", "caption-clip-wipe.html"))).toBe(true);
    expect(res.details).toMatchObject({ kind: "component", src: "components/caption-clip-wipe.html" });
    // The snippet body is returned inline so the agent can merge it directly.
    expect((res.content[0] as { text: string }).text.length).toBeGreaterThan(200);
  });

  it("throws on an unknown item", async () => {
    const tool = makeAddRegistryItemTool({ sessionId: SID, workspaces: wm });
    await expect(tool.execute("c3", { name: "does-not-exist" })).rejects.toThrow(/Unknown registry item/);
  });

  it("applies manifest colors and exact stock-copy replacements before wiring a block", async () => {
    const tool = makeAddRegistryItemTool({ sessionId: SID, workspaces: wm });
    const res = await tool.execute("c-custom", {
      name: "logo-outro",
      values: { "--bg-color": "#123456", "--accent-color": "#FF3366" },
      textReplacements: [
        { from: "Nothing great is made alone.", to: "Build the impossible." },
        { from: "figma.com", to: "acme.com" },
      ],
    });
    const html = readFileSync(join(wm.paths(SID).composition, "logo-outro.html"), "utf8");
    expect(html).toContain("#123456");
    expect(html).toContain("#FF3366");
    expect(html).not.toContain("#0a0a0f");
    expect(html).toContain("Build the impossible.");
    expect(html).toContain("acme.com");
    expect(res.details).toMatchObject({ replacementsApplied: expect.any(Number) });
  });

  it("rejects undeclared tunables", async () => {
    const tool = makeAddRegistryItemTool({ sessionId: SID, workspaces: wm });
    await expect(tool.execute("c-bad", {
      name: "logo-outro", values: { "--unknown": "#ffffff" },
    })).rejects.toThrow(/no tunable named --unknown/);
  });

  it("does not corrupt longer hex colors when replacing a short color token", async () => {
    const tool = makeAddRegistryItemTool({ sessionId: SID, workspaces: wm });
    await tool.execute("c-short-hex", {
      name: "vfx-portal", values: { "--bg-color": "#123456" },
    });
    const html = readFileSync(join(wm.paths(SID).composition, "vfx-portal.html"), "utf8");
    expect(html).not.toContain("#123456000");
    expect(html).toContain("background: #123456");
  });
});

describe("add_registry_item tool (fixture: binary assets + safety)", () => {
  let registryDir: string;
  beforeEach(async () => {
    registryDir = join(root, "registry");
    const itemDir = join(registryDir, "blocks", "demo-block");
    await mkdir(join(itemDir, "models"), { recursive: true });
    await writeFile(
      join(itemDir, "demo-block.html"),
      `<div data-composition-id="demo-block" data-duration="8"></div>`,
    );
    // A non-UTF8 binary asset (a copy must be byte-identical).
    await writeFile(join(itemDir, "models", "thing.glb"), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x10]));
    await writeFile(
      join(itemDir, "registry-item.json"),
      JSON.stringify({
        name: "demo-block",
        type: "hyperframes:block",
        dimensions: { width: 1080, height: 1920 },
        duration: 8,
        files: [
          { path: "demo-block.html", target: "compositions/demo-block.html", type: "hyperframes:composition" },
          { path: "models/thing.glb", target: "models/thing.glb", type: "hyperframes:asset" },
        ],
      }),
    );
  });

  it("copies binary assets byte-for-byte and uses metadata dims/duration", async () => {
    const tool = makeAddRegistryItemTool({ sessionId: SID, workspaces: wm, registryDir });
    const res = await tool.execute("c4", { name: "demo-block" });

    const comp = wm.paths(SID).composition;
    const copiedGlb = readFileSync(join(comp, "models", "thing.glb"));
    expect([...copiedGlb]).toEqual([0x00, 0x01, 0xff, 0xfe, 0x10]);
    expect(res.details).toMatchObject({ kind: "block", width: 1080, height: 1920, duration: 8 });
  });

  it("rejects a target that escapes the composition dir", async () => {
    const itemDir = join(registryDir, "blocks", "evil");
    await mkdir(itemDir, { recursive: true });
    await writeFile(join(itemDir, "x.html"), "<div data-composition-id='evil'></div>");
    await writeFile(
      join(itemDir, "registry-item.json"),
      JSON.stringify({
        name: "evil",
        type: "hyperframes:block",
        files: [{ path: "x.html", target: "compositions/../../escape.html", type: "hyperframes:composition" }],
      }),
    );
    const tool = makeAddRegistryItemTool({ sessionId: SID, workspaces: wm, registryDir });
    await expect(tool.execute("c5", { name: "evil" })).rejects.toThrow(/escapes composition dir/);
  });
});
