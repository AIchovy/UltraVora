import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFile, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Design } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { makeAddRegistryItemTool } from "../src/tools/add-registry-item-tool.js";
import { findRegistryCustomizationViolations } from "../src/registry/registry-customization-check.js";
import { REGISTRY_DIR } from "../src/registry/registry-loader.js";

let root: string;
let workspaces: WorkspaceManager;

const design: Design = {
  mood: "bold", palette: [
    { name: "background", hex: "#123456" },
    { name: "accent", hex: "#FF3366" },
  ],
  colorRoles: { background: "#123456", foreground: "#FFFFFF", accent: "#FF3366" },
  typography: { heading: "Geist", body: "Geist Mono" },
  motionStyle: "confident", keyVisuals: [], sampleFrames: [],
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-reg-check-"));
  workspaces = new WorkspaceManager(root);
  await workspaces.init("s1");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("registry customization check", () => {
  it("flags stock copy and untouched catalog tunables in a wired block", async () => {
    const composition = workspaces.paths("s1").composition;
    await copyFile(
      join(REGISTRY_DIR, "blocks", "logo-outro", "logo-outro.html"),
      join(composition, "logo-outro.html"),
    );
    await writeFile(join(composition, "index.html"),
      `<div data-composition-src="logo-outro.html"></div>`);
    const issues = await findRegistryCustomizationViolations(composition, design);
    expect(issues.join("\n")).toContain("Nothing great is made alone.");
    expect(issues.join("\n")).toContain("--bg-color=#0a0a0f");
  });

  it("passes after install-time brand colors and copy replacements are applied", async () => {
    const composition = workspaces.paths("s1").composition;
    const tool = makeAddRegistryItemTool({ sessionId: "s1", workspaces });
    await tool.execute("c1", {
      name: "logo-outro",
      values: { "--bg-color": "#123456", "--accent-color": "#FF3366" },
      textReplacements: [
        { from: "Nothing great is made alone.", to: "Build the impossible." },
        { from: "figma.com", to: "acme.com" },
      ],
    });
    await writeFile(join(composition, "index.html"),
      `<div data-composition-src="logo-outro.html"></div>`);
    expect(await findRegistryCustomizationViolations(composition, design)).toEqual([]);
  });
});
