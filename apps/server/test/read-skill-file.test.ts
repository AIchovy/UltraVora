// apps/server/test/read-skill-file.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { makeReadSkillFileTool } from "../src/tools/read-skill-file-tool.js";

let root: string;
let skillRoot: string;
let canonicalRoot: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-skill-"));
  skillRoot = join(root, "skills");
  await mkdir(join(skillRoot, "demo", "references"), { recursive: true });
  await writeFile(join(skillRoot, "demo", "SKILL.md"), "# Demo skill\nbody");
  await writeFile(join(skillRoot, "demo", "references", "foo.md"), "reference body");
  // A sentinel OUTSIDE the skill root that a traversal must not reach.
  await writeFile(join(root, "secret.txt"), "top secret");
  // macOS tmpdir is a symlink (/var → /private/var); roots must be canonical so
  // the canonicalized request path comparison succeeds.
  canonicalRoot = await realpath(skillRoot);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function tool() {
  const env = new NodeExecutionEnv({ cwd: root });
  return makeReadSkillFileTool({ env, roots: [canonicalRoot] });
}

describe("read_skill_file tool", () => {
  it("reads a file inside the skill root", async () => {
    const res = await tool().execute("c1", { path: join(skillRoot, "demo", "SKILL.md") });
    expect(res.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Demo skill") });
    expect(res.details).toMatchObject({ kind: "file" });
  });

  it("reads a referenced file resolved under the skill directory", async () => {
    const res = await tool().execute("c2", { path: join(skillRoot, "demo", "references", "foo.md") });
    expect((res.content[0] as { text: string }).text).toBe("reference body");
  });

  it("lists a directory's entries", async () => {
    const res = await tool().execute("c3", { path: join(skillRoot, "demo") });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("SKILL.md");
    expect(text).toContain("references/");
    expect(res.details).toMatchObject({ kind: "directory" });
  });

  it("rejects a path that escapes the skill root", async () => {
    await expect(
      tool().execute("c4", { path: join(skillRoot, "demo", "..", "..", "secret.txt") }),
    ).rejects.toThrow(/outside the skill directories/);
  });

  it("rejects an absolute path outside the root", async () => {
    await expect(
      tool().execute("c5", { path: join(root, "secret.txt") }),
    ).rejects.toThrow(/outside the skill directories/);
  });
});
