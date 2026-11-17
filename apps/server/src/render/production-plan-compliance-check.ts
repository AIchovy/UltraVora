import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Script } from "@ultracreator/shared";
import { SFX_DIR } from "../tools/sfx-tools.js";

const TIMING_TOLERANCE_SEC = 0.12;

interface HtmlClip {
  tag: string;
  id?: string;
  src?: string;
  startSec?: number;
  durationSec?: number;
  volume?: number;
  compositionId?: string;
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    out.set(match[1]!.toLowerCase(), match[3]!);
  }
  return out;
}

/** Parse the timed HTML elements without depending on attribute ordering. */
export function parseCompositionClips(html: string): HtmlClip[] {
  return [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g)].map((match) => {
    const attrs = attributes(match[0]);
    return {
      tag: match[1]!.toLowerCase(),
      ...(attrs.has("id") ? { id: attrs.get("id") } : {}),
      ...(attrs.has("src") ? { src: attrs.get("src") } : {}),
      ...(numeric(attrs.get("data-start")) !== undefined
        ? { startSec: numeric(attrs.get("data-start")) }
        : {}),
      ...(numeric(attrs.get("data-duration")) !== undefined
        ? { durationSec: numeric(attrs.get("data-duration")) }
        : {}),
      ...(numeric(attrs.get("data-volume")) !== undefined
        ? { volume: numeric(attrs.get("data-volume")) }
        : {}),
      ...(attrs.has("data-composition-id")
        ? { compositionId: attrs.get("data-composition-id") }
        : {}),
    };
  });
}

async function licensedSoundEffectFiles(sfxDir: string): Promise<Set<string>> {
  try {
    const manifest = JSON.parse(
      await readFile(join(sfxDir, "manifest.json"), "utf8"),
    ) as Record<string, { file?: string }>;
    return new Set(Object.values(manifest).flatMap((item) =>
      typeof item.file === "string" ? [basename(item.file)] : [],
    ));
  } catch {
    return new Set();
  }
}

const closeTo = (actual: number | undefined, expected: number): boolean =>
  actual !== undefined && Math.abs(actual - expected) <= TIMING_TOLERANCE_SEC;

/**
 * Verify that the director handoff survived implementation: script scenes keep
 * their approved windows, and every planned production SFX lands on its global
 * sync point. This catches a valid-looking composition silently ignoring the
 * storyboard — something lint/layout/visual contact sheets cannot prove.
 */
export async function findProductionPlanComplianceViolations(
  projectDir: string,
  script: Script,
  sfxDir: string = SFX_DIR,
): Promise<string[]> {
  let html: string;
  try {
    html = await readFile(join(projectDir, "index.html"), "utf8");
  } catch {
    return [];
  }
  const clips = parseCompositionClips(html);
  const violations: string[] = [];
  const root = clips.find((clip) => clip.compositionId === "main");
  if (!root || !closeTo(root.durationSec, script.totalSec)) {
    violations.push(
      `Root data-composition-id="main" must keep the approved ${script.totalSec}s duration ` +
        `(found ${root?.durationSec ?? "missing"}).`,
    );
  }

  for (const scene of script.scenes) {
    const clip = clips.find((candidate) => candidate.id === scene.id && candidate.tag !== "audio");
    if (!clip) {
      violations.push(
        `Script scene #${scene.id} is missing as a timed clip. Preserve its id so director ` +
          `timing, review frames and revision diagnostics stay addressable.`,
      );
      continue;
    }
    if (!closeTo(clip.startSec, scene.startSec) || !closeTo(clip.durationSec, scene.durationSec)) {
      violations.push(
        `Scene #${scene.id} must use data-start=${scene.startSec} and ` +
          `data-duration=${scene.durationSec}; found ${clip.startSec ?? "missing"} / ` +
          `${clip.durationSec ?? "missing"}.`,
      );
    }
  }

  if (!script.productionPlan) return violations;
  const licensed = await licensedSoundEffectFiles(sfxDir);
  if (licensed.size === 0) return violations;
  const sfxClips = clips.filter((clip) => {
    if (clip.tag !== "audio" || !clip.src) return false;
    const file = basename(clip.src.split(/[?#]/, 1)[0]!);
    return licensed.has(file);
  });
  const planned = script.productionPlan.scenes.flatMap((direction) => {
    const scene = script.scenes.find((candidate) => candidate.id === direction.sceneId);
    if (!scene) return [];
    return direction.sfxCues.map((cue) => ({
      sceneId: scene.id,
      cue,
      globalTimeSec: scene.startSec + cue.atSec,
    }));
  });

  for (const expected of planned) {
    const match = sfxClips.find((clip) => closeTo(clip.startSec, expected.globalTimeSec));
    if (!match) {
      violations.push(
        `Planned SFX "${expected.cue.type}" for scene #${expected.sceneId} is missing at ` +
          `global t=${expected.globalTimeSec.toFixed(2)}s (scene-local ${expected.cue.atSec}s). ` +
          `Use add_sound_effect and wire the returned file at this sync point.`,
      );
      continue;
    }
    if (
      expected.cue.volume !== undefined &&
      (match.volume === undefined || Math.abs(match.volume - expected.cue.volume) > 0.05)
    ) {
      violations.push(
        `Planned SFX at t=${expected.globalTimeSec.toFixed(2)}s must use volume ` +
          `${expected.cue.volume}; found ${match.volume ?? "missing"}.`,
      );
    }
  }
  for (const clip of sfxClips) {
    if (planned.some((expected) => closeTo(clip.startSec, expected.globalTimeSec))) continue;
    violations.push(
      `Licensed SFX ${JSON.stringify(clip.src)} at t=${clip.startSec ?? "missing"}s is not ` +
        `a director-planned cue. Remove it instead of adding decorative sound clutter.`,
    );
  }
  return violations;
}
