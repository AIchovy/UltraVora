import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { formatSoundEffectsForPrompt, makeAddSoundEffectTool } from "../src/tools/sfx-tools.js";

let root: string;
let sfxDir: string;
let workspaces: WorkspaceManager;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-sfx-"));
  sfxDir = join(root, "sfx");
  await mkdir(sfxDir);
  await writeFile(join(sfxDir, "impact.mp3"), Buffer.from([1, 2, 3]));
  await writeFile(join(sfxDir, "manifest.json"), JSON.stringify({
    impact: { file: "impact.mp3", duration: 1.25, description: "Deep product reveal hit" },
  }));
  workspaces = new WorkspaceManager(join(root, "workspaces"));
  await workspaces.init("s1");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("sound effect tool", () => {
  it("copies a whitelisted effect and returns timeline wiring", async () => {
    const tool = makeAddSoundEffectTool({ sessionId: "s1", workspaces, sfxDir });
    const result = await tool.execute("c1", { name: "impact" });
    expect(existsSync(join(workspaces.paths("s1").composition, "impact.mp3"))).toBe(true);
    expect(result.details).toMatchObject({ file: "impact.mp3", duration: 1.25 });
    expect((result.content[0] as { text: string }).text).toContain("data-start");
  });

  it("rejects unknown effects", async () => {
    const tool = makeAddSoundEffectTool({ sessionId: "s1", workspaces, sfxDir });
    await expect(tool.execute("c2", { name: "../../secret" })).rejects.toThrow(/Unknown sound effect/);
  });

  it("publishes a concise licensed catalog", async () => {
    const text = await formatSoundEffectsForPrompt(sfxDir);
    expect(text).toContain("impact (1.25s)");
    expect(text).toContain("maximum 6 cues");
  });
});
