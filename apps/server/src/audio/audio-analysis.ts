import { spawn } from "node:child_process";

export interface AudioEnergyFrame {
  timeSec: number;
  rms: number;
}

export interface AudioBeatAnalysis {
  durationSec: number;
  fps: number;
  bpm?: number;
  beatTimesSec: number[];
  energyPeaksSec: number[];
  frames: AudioEnergyFrame[];
}

export interface AudioAnalyzer {
  analyze(path: string, signal?: AbortSignal): Promise<AudioBeatAnalysis | null>;
}

const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

/** Analyze decoded mono PCM without runtime DSP dependencies. */
export function analyzePcm16(
  pcm: Buffer,
  sampleRate = 44_100,
  fps = 30,
): AudioBeatAnalysis {
  const samplesPerFrame = Math.max(1, Math.floor(sampleRate / fps));
  const sampleCount = Math.floor(pcm.byteLength / 2);
  const totalFrames = Math.floor(sampleCount / samplesPerFrame);
  const rawRms: number[] = [];
  for (let frame = 0; frame < totalFrames; frame++) {
    let sumSquares = 0;
    const start = frame * samplesPerFrame;
    const end = Math.min(sampleCount, start + samplesPerFrame);
    for (let index = start; index < end; index++) {
      const sample = pcm.readInt16LE(index * 2) / 32768;
      sumSquares += sample * sample;
    }
    rawRms.push(Math.sqrt(sumSquares / Math.max(1, end - start)));
  }
  const signalPeak = rawRms.reduce((maximum, value) => Math.max(maximum, value), 0);
  if (signalPeak <= 1e-8) {
    return {
      durationSec: round(sampleCount / sampleRate),
      fps,
      beatTimesSec: [],
      energyPeaksSec: [],
      frames: rawRms.map((_, index) => ({ timeSec: round(index / fps), rms: 0 })),
    };
  }
  const peak = signalPeak;
  const normalized = rawRms.map((value) => value / peak);
  const onset = normalized.map((value, index) => {
    const history = normalized.slice(Math.max(0, index - 8), index);
    const baseline = history.length
      ? history.reduce((sum, item) => sum + item, 0) / history.length
      : value;
    return Math.max(0, value - baseline);
  });
  const threshold = Math.max(0.06, percentile(onset, 0.78));
  const candidates = onset
    .map((strength, index) => ({ index, strength }))
    .filter(({ index, strength }) =>
      strength >= threshold &&
      strength >= (onset[index - 1] ?? 0) &&
      strength >= (onset[index + 1] ?? 0),
    );
  const minGapFrames = Math.max(1, Math.round(fps * 0.28));
  const selected: Array<{ index: number; strength: number }> = [];
  for (const candidate of candidates) {
    const previous = selected.at(-1);
    if (!previous || candidate.index - previous.index >= minGapFrames) {
      selected.push(candidate);
    } else if (candidate.strength > previous.strength) {
      selected[selected.length - 1] = candidate;
    }
  }
  const beatTimesSec = selected.map(({ index }) => round(index / fps));
  const intervals = beatTimesSec.slice(1)
    .map((time, index) => time - beatTimesSec[index]!)
    .filter((interval) => interval >= 0.3 && interval <= 1.2);
  let bpm: number | undefined;
  if (intervals.length >= 2) {
    const median = percentile(intervals, 0.5);
    let estimated = 60 / median;
    while (estimated < 70) estimated *= 2;
    while (estimated > 180) estimated /= 2;
    bpm = Math.round(estimated);
  }
  const peakThreshold = percentile(normalized, 0.88);
  const energyPeaksSec = normalized
    .map((value, index) => ({ value, index }))
    .filter(({ value, index }) =>
      value >= peakThreshold &&
      value >= (normalized[index - 1] ?? 0) &&
      value >= (normalized[index + 1] ?? 0),
    )
    .filter((item, index, all) => index === 0 || item.index - all[index - 1]!.index >= minGapFrames)
    .slice(0, 24)
    .map(({ index }) => round(index / fps));

  return {
    durationSec: round(sampleCount / sampleRate),
    fps,
    ...(bpm === undefined ? {} : { bpm }),
    beatTimesSec: beatTimesSec.slice(0, 80),
    energyPeaksSec,
    frames: normalized.map((rms, index) => ({ timeSec: round(index / fps), rms: round(rms, 4) })),
  };
}

function decodeWithFfmpeg(
  path: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", [
      "-i", path, "-vn", "-ac", "1", "-ar", "44100", "-f", "s16le",
      "-acodec", "pcm_s16le", "-loglevel", "error", "pipe:1",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(null); }, timeoutMs);
    const onAbort = () => { try { child.kill("SIGKILL"); } catch {} finish(null); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 32 * 1024 * 1024) {
        try { child.kill("SIGKILL"); } catch {}
        finish(null);
      } else {
        chunks.push(chunk);
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? Buffer.concat(chunks) : null));
  });
}

export class FfmpegAudioAnalyzer implements AudioAnalyzer {
  constructor(private timeoutMs = 30_000) {}

  async analyze(path: string, signal?: AbortSignal): Promise<AudioBeatAnalysis | null> {
    const pcm = await decodeWithFfmpeg(path, this.timeoutMs, signal);
    return pcm && pcm.length > 0 ? analyzePcm16(pcm) : null;
  }
}
