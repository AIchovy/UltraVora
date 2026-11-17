import { describe, expect, it } from "vitest";
import { analyzePcm16 } from "../src/audio/audio-analysis.js";

function pulseTrack(durationSec: number, sampleRate: number, pulseTimes: number[]): Buffer {
  const samples = new Int16Array(durationSec * sampleRate);
  for (const time of pulseTimes) {
    const start = Math.floor(time * sampleRate);
    const end = Math.min(samples.length, start + Math.floor(sampleRate * 0.08));
    for (let index = start; index < end; index++) {
      samples[index] = Math.round(Math.sin((index - start) * 0.3) * 24_000);
    }
  }
  return Buffer.from(samples.buffer);
}

describe("audio beat analysis", () => {
  it("finds rhythmic onset points and estimates BPM", () => {
    const analysis = analyzePcm16(
      pulseTrack(4, 44_100, [0.5, 1, 1.5, 2, 2.5, 3, 3.5]),
      44_100,
      30,
    );
    expect(analysis.durationSec).toBe(4);
    expect(analysis.beatTimesSec.length).toBeGreaterThanOrEqual(5);
    expect(analysis.beatTimesSec[0]).toBeCloseTo(0.5, 1);
    expect(analysis.bpm).toBeGreaterThanOrEqual(115);
    expect(analysis.bpm).toBeLessThanOrEqual(125);
    expect(Math.max(...analysis.frames.map((frame) => frame.rms))).toBe(1);
  });

  it("handles silence without inventing beat times", () => {
    const analysis = analyzePcm16(Buffer.alloc(44_100 * 2 * 2));
    expect(analysis.beatTimesSec).toEqual([]);
    expect(analysis.bpm).toBeUndefined();
  });
});
