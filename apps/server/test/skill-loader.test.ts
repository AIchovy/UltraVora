// apps/server/test/skill-loader.test.ts
import { describe, it, expect } from "vitest";
import { isAbsolute } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { loadComposeSkills, COMPOSE_SKILL_DIRS } from "../src/skills/skill-loader.js";

describe("loadComposeSkills", () => {
  it("loads the vendored gsap + hyperframes skill trees with no error diagnostics", async () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const { skills, roots } = await loadComposeSkills(env);

    const names = skills.map((s) => s.name);
    // Core authoring skills must be present (the hyperframes tree includes its
    // own `gsap` skill).
    expect(names).toContain("hyperframes");
    expect(names).toContain("gsap");
    // The standalone gsap-skills tree (vendor/gsap) is currently NOT loaded.
    expect(names).not.toContain("gsap-timeline");
    expect(skills.length).toBeGreaterThanOrEqual(10);

    // Every loaded skill carries an absolute filePath (the read tool relies on this).
    for (const s of skills) {
      expect(isAbsolute(s.filePath)).toBe(true);
      expect(s.description.length).toBeGreaterThan(0);
    }

    // Two canonical, absolute roots (used to confine read_skill_file).
    expect(roots).toHaveLength(COMPOSE_SKILL_DIRS.length);
    for (const r of roots) expect(isAbsolute(r)).toBe(true);
  });

  it("skips missing directories without throwing", async () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const { skills } = await loadComposeSkills(env, ["/nonexistent/skills/dir"]);
    expect(skills).toEqual([]);
  });
});
