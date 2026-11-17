// apps/server/src/skills/skill-loader.ts
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadSkills, TODO_CONTEXT, type Skill } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";

/**
 * Base directory of the vendored skill trees, resolved relative to THIS module
 * (cwd-independent; works under tsx with no build step). The skills are copied
 * into the server source tree so the server is self-contained — it does not
 * depend on the (gitignored) upstream clones at the repo root.
 */
export const SKILLS_BASE_DIR = fileURLToPath(new URL("vendor/", import.meta.url));

/**
 * The vendored skill trees. `loadSkills` traverses each directory recursively,
 * parsing every `SKILL.md` (and root-level `.md`) into a {@link Skill}.
 *
 * - `vendor/gsap`        → gsap-core, gsap-timeline, gsap-scrolltrigger, … (8)
 * - `vendor/hyperframes` → hyperframes (+ references/palettes/transitions),
 *   gsap, css-animations, three, waapi, animejs, lottie, tailwind, … (15)
 */
export const COMPOSE_SKILL_DIRS: readonly string[] = [
  // Temporarily not loading the gsap skill tree (vendor/gsap):
  // join(SKILLS_BASE_DIR, "gsap"),
  join(SKILLS_BASE_DIR, "hyperframes"),
];

export interface LoadComposeSkillsResult {
  skills: Skill[];
  /** Absolute, normalized root directories the skills were loaded from. Used to
   *  confine the read_skill_file tool. */
  roots: string[];
}

/**
 * Load every authoring skill the compose agent may consult.
 *
 * Diagnostics (invalid/unreadable SKILL.md files) are logged as warnings rather
 * than thrown — a single malformed skill should not fail the whole phase.
 */
export async function loadComposeSkills(
  env: ExecutionEnv,
  dirs: readonly string[] = COMPOSE_SKILL_DIRS,
): Promise<LoadComposeSkillsResult> {
  const { skills, diagnostics } = await loadSkills(env, [...dirs], TODO_CONTEXT);
  for (const d of diagnostics) {
    // eslint-disable-next-line no-console
    console.warn(`[skill-loader] ${d.code} at ${d.path}: ${d.message}`);
  }
  // Canonicalize the roots so the read tool can compare resolved paths safely.
  const roots: string[] = [];
  for (const dir of dirs) {
    const canon = await env.canonicalPath(dir, TODO_CONTEXT);
    roots.push(canon.ok ? canon.value : dir.replace(/\/+$/, ""));
  }
  return { skills, roots };
}
