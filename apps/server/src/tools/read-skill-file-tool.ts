// apps/server/src/tools/read-skill-file-tool.ts
import { sep } from "node:path";
import { type Static, Type } from "typebox";
import {
  TODO_CONTEXT,
  withAbortSignal,
  type AgentTool,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";

const parameters = Type.Object({
  path: Type.String({
    description:
      "Absolute path to a skill file or directory. Use the `location` shown for a skill " +
      "in the <available_skills> listing (its SKILL.md), or any file that SKILL.md " +
      "references — resolve those relative to the SKILL.md's own directory. Reading a " +
      "directory returns its entries so you can discover references/, palettes/, transitions/, etc.",
  }),
});

export interface ReadSkillFileToolOptions {
  env: ExecutionEnv;
  /** Absolute, canonical skill root directories. Reads are confined to these. */
  roots: string[];
}

/**
 * Lets the compose agent progressively pull the full skill instructions it needs:
 * a SKILL.md body, or any `references/` / `palettes/` / `transitions/` file it points to.
 *
 * The harness ships no Read tool and its skill system is invocation-only, so this
 * tool is what turns the static <available_skills> listing into true progressive
 * (model-driven) loading. Every requested path is canonicalized and rejected if it
 * escapes the vendored skill roots.
 */
export function makeReadSkillFileTool(opts: ReadSkillFileToolOptions): AgentTool<typeof parameters> {
  const { env, roots } = opts;
  return {
    name: "read_skill_file",
    label: "Read Skill File",
    description:
      "Read a skill's SKILL.md or any file/directory it references (references/, palettes/, " +
      "transitions/, …). Paths come from the <available_skills> listing in your system prompt. " +
      "Call this to load the full instructions for the skills relevant to this composition " +
      "before authoring.",
    parameters,
    execute: async (_callId: string, params: Static<typeof parameters>, signal?: AbortSignal) => {
      const context = signal ? withAbortSignal(signal, TODO_CONTEXT) : TODO_CONTEXT;
      const canon = await env.canonicalPath(params.path, context);
      if (!canon.ok) {
        throw new Error(`Cannot resolve skill path "${params.path}": ${canon.error.code}`);
      }
      const resolved = canon.value;
      const within = roots.some((r) => resolved === r || resolved.startsWith(r.endsWith(sep) ? r : r + sep));
      if (!within) {
        throw new Error(`Path is outside the skill directories: ${params.path}`);
      }

      const info = await env.fileInfo(resolved, context);
      if (!info.ok) {
        throw new Error(`Cannot stat skill path "${params.path}": ${info.error.code}`);
      }

      if (info.value.kind === "directory") {
        const listed = await env.listDir(resolved, context);
        if (!listed.ok) {
          throw new Error(`Cannot list skill directory "${params.path}": ${listed.error.code}`);
        }
        const names = listed.value
          .map((f) => (f.kind === "directory" ? `${f.name}/` : f.name))
          .sort()
          .join("\n");
        return {
          content: [{ type: "text", text: names || "(empty directory)" }],
          details: { path: resolved, kind: "directory", entries: listed.value.length },
        };
      }

      const text = await env.readTextFile(resolved, context);
      if (!text.ok) {
        throw new Error(`Cannot read skill file "${params.path}": ${text.error.code}`);
      }
      return {
        content: [{ type: "text", text: text.value }],
        details: { path: resolved, kind: "file", bytes: Buffer.byteLength(text.value, "utf8") },
      };
    },
  };
}
