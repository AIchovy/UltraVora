/**
 * Pixel-level rendered-frame checks, one headless-Chrome snapshot run for both:
 *
 * - BLANK frames: snapshot each scene's midpoint and flag near-uniform dark
 *   frames. The static scene-reveal regex only guards ONE blank-scene
 *   mechanism; two others already shipped to prod (grid cells collapsing to 0
 *   height; a position-0 hide-all tl.set colliding with reveals). The defect
 *   class is open-ended — only looking at rendered pixels closes it.
 * - STATIC holds: for long scenes, snapshot a second point late in the hold
 *   and pixel-diff it against the midpoint. Entrance tweens cover only the
 *   first ~1-2s; a scene that then freezes for 5+ seconds reads as a broken
 *   render (prod session 45a7b61e). The hyperframes runtime virtualizes time
 *   (GSAP, CSS animations, video all seek deterministically), so a truly
 *   frozen hold produces near-identical PNGs and the diff threshold can be
 *   tight — motion invisible to the diff is invisible to viewers too.
 *
 * Uses `hyperframes snapshot --at …` (headless Chrome; writes
 * snapshots/frame-NN-at-<t.toFixed(1)>s.png) + sharp. Best-effort by design:
 * tooling failures return [] — this net must never block a healthy
 * composition.
 */
import { spawn } from "node:child_process";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

export interface SceneWindow {
  id: string;
  startSec: number;
  durationSec: number;
}

/**
 * Scene clips (id + window) from a composition's HTML. Elements need
 * data-start AND data-duration; the root (data-composition-id), <audio> clips
 * and audio-track clips are not scenes.
 */
export function parseSceneWindows(indexHtml: string): SceneWindow[] {
  const scenes: SceneWindow[] = [];
  for (const m of indexHtml.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\bdata-start\s*=\s*"([^"]+)"[^>]*>/g)) {
    const tag = m[1]!.toLowerCase();
    const attrs = m[0];
    if (tag === "audio") continue; // audio clips are never scenes
    if (/data-composition-id\s*=/.test(attrs)) continue; // the root, not a scene
    if (/data-track-index\s*=\s*"0"/.test(attrs)) continue; // audio track
    const duration = attrs.match(/data-duration\s*=\s*"([^"]+)"/)?.[1];
    if (duration === undefined) continue;
    const start = Number(m[2]);
    const dur = Number(duration);
    if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
    const id = attrs.match(/\bid\s*=\s*"([^"]+)"/)?.[1] ?? `t${start}`;
    scenes.push({ id, startSec: start, durationSec: dur });
  }
  return scenes;
}

/** A frame is "blank" when near-uniform AND dark: nothing legible rendered. */
export const BLANK_LUMA_STDDEV = 6;
export const BLANK_LUMA_MEAN = 20;

/** Every frame file in `snapshotsDir` with its parsed at-time. */
async function listFrameTimes(
  snapshotsDir: string,
): Promise<Array<{ file: string; timeSec: number }>> {
  let files: string[] = [];
  try {
    files = (await readdir(snapshotsDir)).filter((f) => /^frame-.*\.png$/i.test(f));
  } catch {
    return [];
  }
  return files
    .map((file) => ({ file, timeSec: Number(file.match(/at-([\d.]+)s/)?.[1]) }))
    .filter((e) => Number.isFinite(e.timeSec));
}

/**
 * Inspect the PNGs in `snapshotsDir` (frame-NN-at-<t>s.png) and report the
 * scenes whose sampled frame is near-uniform dark, plus the ids of the
 * affected scenes (so the static-hold check can skip already-blank scenes).
 */
export async function analyzeBlankFrames(
  snapshotsDir: string,
  scenes: SceneWindow[],
): Promise<{ messages: string[]; sceneIds: Set<string> }> {
  const entries = await listFrameTimes(snapshotsDir);
  const messages: string[] = [];
  const sceneIds = new Set<string>();
  for (const { file, timeSec: t } of entries) {
    let mean: number;
    let stdev: number;
    try {
      const stats = await sharp(join(snapshotsDir, file)).greyscale().stats();
      mean = stats.channels[0]!.mean;
      stdev = stats.channels[0]!.stdev;
    } catch {
      continue;
    }
    if (stdev >= BLANK_LUMA_STDDEV || mean >= BLANK_LUMA_MEAN) continue;
    const scene = scenes.find(
      (s) => t >= s.startSec && t < s.startSec + s.durationSec,
    );
    if (scene) sceneIds.add(scene.id);
    messages.push(
      `Frame at t=${t}s${scene ? ` (scene #${scene.id})` : ""} renders nearly black ` +
        `(luma mean ${mean.toFixed(1)}, stddev ${stdev.toFixed(1)}) — the scene's content is not ` +
        `visible at that point. Common causes: a gsap.from() on an already-hidden container ` +
        `(animates 0→0), a hide-all tl.set at position 0 colliding with the reveal, or grid/flex ` +
        `cells collapsing to 0 height. Make the scene's content actually visible.`,
    );
  }
  return { messages, sceneIds };
}

/** Back-compat message-only view of {@link analyzeBlankFrames}. */
export async function analyzeSnapshots(
  snapshotsDir: string,
  scenes: SceneWindow[],
): Promise<string[]> {
  return (await analyzeBlankFrames(snapshotsDir, scenes)).messages;
}

/** Scenes shorter than this are all entrance — no hold to check. */
export const MIN_HOLD_CHECK_SEC = 6;
/** The hold sample sits this far before the scene's end (clear of the next scene's transition). */
export const HOLD_END_OFFSET_SEC = 2.0;
/** Per-pixel luma delta below this counts as "unchanged". */
export const STATIC_HOLD_DELTA = 4;
/** A hold is static when fewer than this fraction of pixels changed. */
export const STATIC_HOLD_CHANGED_FRACTION = 0.003;
/** CLI labels frames at toFixed(1) → max 0.05s rounding error. */
const FRAME_TIME_TOLERANCE_SEC = 0.06;

export interface PlannedSample {
  scene: SceneWindow;
  timeSec: number;
}

export interface FrameSamplePlan {
  /** Every sampled scene's midpoint — the blank check. */
  midpoints: PlannedSample[];
  /** A second, late-hold sample for long scenes — the static-hold diff. */
  holds: PlannedSample[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Which frames to snapshot: every sampled scene's midpoint, plus a late hold
 * point for scenes long enough to have a hold worth checking. Midpoint and
 * hold are ≥1s apart for eligible scenes (duration/2 - HOLD_END_OFFSET ≥ 1 at
 * 6s), comfortably above the CLI's 0.1s filename rounding.
 */
export function planFrameSamples(scenes: SceneWindow[], maxScenes = 8): FrameSamplePlan {
  const sampled = scenes.length <= maxScenes
    ? scenes
    : scenes.filter((_, i) => i % Math.ceil(scenes.length / maxScenes) === 0).slice(0, maxScenes);
  const midpoints = sampled.map((scene) => ({
    scene,
    timeSec: round2(scene.startSec + scene.durationSec / 2),
  }));
  const holds = sampled
    .filter((scene) => scene.durationSec >= MIN_HOLD_CHECK_SEC)
    .map((scene) => ({
      scene,
      timeSec: round2(scene.startSec + scene.durationSec - HOLD_END_OFFSET_SEC),
    }));
  return { midpoints, holds };
}

/**
 * Pixel-diff each long scene's midpoint frame against its late-hold frame and
 * report scenes that freeze after their entrance. Scenes already flagged
 * blank are skipped (one defect, one message). Best-effort: missing frames or
 * unreadable PNGs are silently skipped.
 */
export async function analyzeStaticHolds(
  snapshotsDir: string,
  plan: FrameSamplePlan,
  blankSceneIds: ReadonlySet<string>,
): Promise<string[]> {
  const entries = await listFrameTimes(snapshotsDir);
  const frameFor = (timeSec: number) =>
    entries.find((e) => Math.abs(e.timeSec - timeSec) <= FRAME_TIME_TOLERANCE_SEC) ?? null;

  const violations: string[] = [];
  for (const hold of plan.holds) {
    if (blankSceneIds.has(hold.scene.id)) continue;
    const mid = plan.midpoints.find((m) => m.scene.id === hold.scene.id);
    if (!mid) continue;
    const midFrame = frameFor(mid.timeSec);
    const holdFrame = frameFor(hold.timeSec);
    if (!midFrame || !holdFrame || midFrame.file === holdFrame.file) continue;

    let a: { data: Buffer; info: sharp.OutputInfo };
    let b: { data: Buffer; info: sharp.OutputInfo };
    try {
      a = await sharp(join(snapshotsDir, midFrame.file)).greyscale().raw().toBuffer({ resolveWithObject: true });
      b = await sharp(join(snapshotsDir, holdFrame.file)).greyscale().raw().toBuffer({ resolveWithObject: true });
    } catch {
      continue;
    }
    if (a.info.width !== b.info.width || a.info.height !== b.info.height) continue;
    let changed = 0;
    for (let i = 0; i < a.data.length; i++) {
      if (Math.abs(a.data[i]! - b.data[i]!) >= STATIC_HOLD_DELTA) changed++;
    }
    if (changed / a.data.length >= STATIC_HOLD_CHANGED_FRACTION) continue;

    violations.push(
      `Scene #${hold.scene.id} shows no visible motion between t=${mid.timeSec}s and t=${hold.timeSec}s — ` +
        `after its entrance it freezes into a static frame for the rest of its ${hold.scene.durationSec}s window. ` +
        `Add ambient motion spanning the scene's FULL duration: a slow Ken Burns on the hero image/background ` +
        `(scale 1→1.05 with the tween duration = the scene's remaining window), drifting decorative shapes, or ` +
        `a finite yoyo loop sized to cover the window (e.g. {x: 60, duration: 3, ease: "sine.inOut", repeat: 3, ` +
        `yoyo: true} — never repeat: -1, which fails lint). Make it visible: move elements ≥3% of the frame or ` +
        `scale imagery ≥4%. Target imagery/decoratives that sit INSIDE the frame — never scale a full-frame ` +
        `content wrapper (it overflows the scene's clip edge and fails the overflow inspection); for a deliberate ` +
        `full-bleed Ken Burns, mark the scaled element data-layout-allow-overflow.`,
    );
  }
  return violations;
}

/**
 * Delete leftover frame PNGs from a previous run. Neither the CLI nor the
 * server ever cleaned this dir, so frames from an older composition version
 * would be analyzed against the new scene windows (false blanks, corrupted
 * static-hold diffs on revision runs).
 */
async function clearFrameSnapshots(snapshotsDir: string): Promise<void> {
  let files: string[] = [];
  try {
    files = await readdir(snapshotsDir);
  } catch {
    return; // no dir yet — nothing stale
  }
  await Promise.all(
    files
      .filter((f) => /^frame-.*\.png$/i.test(f))
      .map((f) => unlink(join(snapshotsDir, f)).catch(() => undefined)),
  );
}

export interface BlankFrameCheckOptions {
  /** Override the spawned argv (tests). */
  commandFor?: (dir: string, atTimes: number[]) => string[];
  timeoutMs?: number;
  /** Cap on how many scenes to sample. Default 8. */
  maxScenes?: number;
  signal?: AbortSignal;
}

// Up to 2 frames per sampled scene on a 2-vCPU prod box.
const DEFAULT_TIMEOUT_MS = 150 * 1000;

function defaultCommand(dir: string, atTimes: number[]): string[] {
  return [
    "npx", "--package=hyperframes", "hyperframes", "snapshot", dir,
    "--at", atTimes.map((t) => t.toFixed(2)).join(","),
    "--describe", "false",
  ];
}

function runProcess(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    const [exe, ...args] = argv;
    const child = spawn(exe!, args, { stdio: ["ignore", "ignore", "ignore"] });
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(124); }, timeoutMs);
    const onAbort = () => { try { child.kill("SIGKILL"); } catch {} finish(130); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

/**
 * One snapshot run, two checks: report scenes that render near-black at any
 * sampled point, and long scenes that freeze between their midpoint and late
 * hold. [] on any tooling failure.
 */
export async function findRenderedFrameIssues(
  projectDir: string,
  opts: BlankFrameCheckOptions = {},
): Promise<string[]> {
  let html: string;
  try {
    html = await readFile(join(projectDir, "index.html"), "utf8");
  } catch {
    return [];
  }
  const scenes = parseSceneWindows(html);
  if (scenes.length === 0) return [];

  const plan = planFrameSamples(scenes, opts.maxScenes ?? 8);
  const times = [...plan.midpoints, ...plan.holds]
    .map((s) => s.timeSec)
    .sort((x, y) => x - y);

  const snapshotsDir = join(projectDir, "snapshots");
  await clearFrameSnapshots(snapshotsDir);

  const commandFor = opts.commandFor ?? defaultCommand;
  const code = await runProcess(
    commandFor(projectDir, times),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    opts.signal,
  );
  if (code !== 0) return []; // tooling failure must never block the composition

  const blank = await analyzeBlankFrames(snapshotsDir, scenes);
  const statics = await analyzeStaticHolds(snapshotsDir, plan, blank.sceneIds);
  return [...blank.messages, ...statics];
}
