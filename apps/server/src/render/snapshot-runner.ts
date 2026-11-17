import { spawn } from "node:child_process";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ProductionPlan, Scene } from "@ultracreator/shared";

export interface CriticSample {
  sceneId: string;
  timeSec: number;
  moment: "build" | "hero" | "resolve";
}

export interface CapturedCriticFrame extends CriticSample {
  path: string;
}

export interface SnapshotRunner {
  capture(
    projectDir: string,
    samples: CriticSample[],
    signal: AbortSignal,
  ): Promise<CapturedCriticFrame[]>;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface CriticSamplePlanOptions {
  maxFrames?: number;
  productionPlan?: ProductionPlan;
}

/** Two or three editorially meaningful frames per scene, capped for latency. */
export function planCriticSamples(
  scenes: Scene[],
  options: number | CriticSamplePlanOptions = 18,
): CriticSample[] {
  const maxFrames = typeof options === "number" ? options : options.maxFrames ?? 18;
  const plannedHeroOffsets = new Map(
    (typeof options === "number" ? [] : options.productionPlan?.scenes ?? [])
      .map((direction) => [direction.sceneId, direction.heroFrameAtSec]),
  );
  const samples = scenes.flatMap((scene) => {
    const end = scene.startSec + scene.durationSec;
    const inset = Math.min(0.2, scene.durationSec * 0.05);
    const plannedHeroOffset = plannedHeroOffsets.get(scene.id);
    const heroTime = plannedHeroOffset === undefined
      ? scene.startSec + scene.durationSec * 0.58
      : scene.startSec + Math.min(
          Math.max(inset, plannedHeroOffset),
          Math.max(inset, scene.durationSec - inset),
        );
    return [
      { sceneId: scene.id, timeSec: round2(scene.startSec + scene.durationSec * 0.22), moment: "build" as const },
      { sceneId: scene.id, timeSec: round2(heroTime), moment: "hero" as const },
      { sceneId: scene.id, timeSec: round2(Math.max(scene.startSec, end - inset)), moment: "resolve" as const },
    ];
  });
  if (samples.length <= maxFrames) return samples;
  // Keep every hero frame first, then add build/resolve coverage evenly.
  const heroes = samples.filter((sample) => sample.moment === "hero");
  const remaining = samples.filter((sample) => sample.moment !== "hero");
  const room = Math.max(0, maxFrames - heroes.length);
  const stride = Math.max(1, Math.ceil(remaining.length / Math.max(1, room)));
  return [...heroes, ...remaining.filter((_, index) => index % stride === 0).slice(0, room)]
    .sort((a, b) => a.timeSec - b.timeSec);
}

async function clearSnapshots(dir: string): Promise<void> {
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return; }
  await Promise.all(names
    .filter((name) => /^frame-.*\.png$/i.test(name))
    .map((name) => unlink(join(dir, name)).catch(() => undefined)));
}

function run(argv: string[], timeoutMs: number, signal: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    const [exe, ...args] = argv;
    const child = spawn(exe!, args, { stdio: ["ignore", "ignore", "ignore"] });
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(code);
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(124); }, timeoutMs);
    const onAbort = () => { try { child.kill("SIGKILL"); } catch {} finish(130); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

export interface HyperframesSnapshotRunnerOptions {
  commandFor?: (projectDir: string, times: number[]) => string[];
  timeoutMs?: number;
}

export class HyperframesSnapshotRunner implements SnapshotRunner {
  constructor(private opts: HyperframesSnapshotRunnerOptions = {}) {}

  async capture(
    projectDir: string,
    samples: CriticSample[],
    signal: AbortSignal,
  ): Promise<CapturedCriticFrame[]> {
    if (samples.length === 0 || signal.aborted) return [];
    const snapshotsDir = join(projectDir, "snapshots");
    await clearSnapshots(snapshotsDir);
    const times = samples.map((sample) => sample.timeSec);
    const argv = this.opts.commandFor?.(projectDir, times) ?? [
      "npx", "--package=hyperframes", "hyperframes", "snapshot", projectDir,
      "--at", times.map((time) => time.toFixed(2)).join(","), "--describe", "false",
    ];
    const code = await run(argv, this.opts.timeoutMs ?? 180_000, signal);
    if (code !== 0) return [];
    let names: string[] = [];
    try { names = await readdir(snapshotsDir); } catch { return []; }
    const frames = names
      .map((name) => ({ name, timeSec: Number(name.match(/at-([\d.]+)s/)?.[1]) }))
      .filter((entry) => /^frame-.*\.png$/i.test(entry.name) && Number.isFinite(entry.timeSec));
    return samples.flatMap((sample) => {
      const match = frames.find((frame) => Math.abs(frame.timeSec - sample.timeSec) <= 0.06);
      return match ? [{ ...sample, path: join(snapshotsDir, match.name) }] : [];
    });
  }
}
