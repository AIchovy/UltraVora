import { copyFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

export const SFX_DIR = fileURLToPath(
  new URL("../skills/vendor/hyperframes/website-to-hyperframes/assets/sfx/", import.meta.url),
);

interface SfxEntry {
  file: string;
  duration: number;
  description: string;
}

const parameters = Type.Object({
  name: Type.String({ description: "Licensed SFX name from the <sound_effects> catalog." }),
});

export interface AddSoundEffectToolOptions {
  sessionId: string;
  workspaces: WorkspaceManager;
  /** Override for tests. */
  sfxDir?: string;
}

async function loadManifest(sfxDir: string): Promise<Record<string, SfxEntry>> {
  return JSON.parse(await readFile(join(sfxDir, "manifest.json"), "utf8")) as Record<string, SfxEntry>;
}

export async function formatSoundEffectsForPrompt(sfxDir: string = SFX_DIR): Promise<string> {
  const manifest = await loadManifest(sfxDir);
  return [
    "<sound_effects>",
    "Licensed production SFX available through add_sound_effect:",
    ...Object.entries(manifest).map(
      ([name, item]) => `  - ${name} (${item.duration}s): ${item.description}`,
    ),
    "Use only cues present in the director plan (or an equivalent closest match). Keep the mix sparse:",
    "maximum 6 cues, normally volume 0.18-0.45. Place each as an <audio> clip on its own track",
    "with global data-start, the returned duration, and the returned bare src filename.",
    "</sound_effects>",
  ].join("\n");
}

export function makeAddSoundEffectTool(
  opts: AddSoundEffectToolOptions,
): AgentTool<typeof parameters> {
  const sfxDir = opts.sfxDir ?? SFX_DIR;
  return {
    name: "add_sound_effect",
    label: "Add Sound Effect",
    description: "Copy one licensed production sound effect into the composition directory.",
    parameters,
    execute: async (_callId: string, params: Static<typeof parameters>) => {
      const manifest = await loadManifest(sfxDir);
      const item = manifest[params.name];
      if (!item) throw new Error(`Unknown sound effect: ${params.name}`);
      // The manifest is trusted vendor data, but basename keeps future edits
      // from accidentally turning it into a path traversal primitive.
      const file = basename(item.file);
      if (file !== item.file) throw new Error(`Unsafe sound effect filename: ${item.file}`);
      const compositionDir = opts.workspaces.paths(opts.sessionId).composition;
      await mkdir(compositionDir, { recursive: true });
      await copyFile(join(sfxDir, file), join(compositionDir, file));
      return {
        content: [{
          type: "text",
          text:
            `Added licensed SFX "${params.name}" as ${file} (${item.duration}s). ` +
            `Wire it as <audio src="${file}" data-start="..." data-duration="${item.duration}" ` +
            `data-track-index="..." data-volume="..."> using the storyboard's global cue time.`,
        }],
        details: { name: params.name, file, duration: item.duration },
      };
    },
  };
}
