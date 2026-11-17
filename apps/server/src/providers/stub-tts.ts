import { writeFile } from "node:fs/promises";
import type { TTSInput, TTSProvider, TTSResult, WordTiming } from "./types.js";

export interface StubTTSOptions {
  withTimings?: boolean;
  /** Milliseconds of silence to emit per word; default 200. */
  msPerWord?: number;
}

const SAMPLE_RATE = 24000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;

function buildSilenceWav(durationMs: number): Buffer {
  const numSamples = Math.max(1, Math.round((durationMs / 1000) * SAMPLE_RATE));
  const dataSize = numSamples * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(NUM_CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 28);
  buf.writeUInt16LE(NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  // The data region stays zeroed → silence.
  return buf;
}

export class StubTTSProvider implements TTSProvider {
  readonly id = "stub";
  private msPerWord: number;
  private withTimings: boolean;

  constructor(opts: StubTTSOptions = {}) {
    this.msPerWord = opts.msPerWord ?? 200;
    this.withTimings = opts.withTimings ?? false;
  }

  async synthesize(input: TTSInput): Promise<TTSResult> {
    if (input.signal?.aborted) throw new Error("Aborted");
    const words = input.text.split(/\s+/).filter(Boolean);
    const durationMs = Math.max(this.msPerWord, words.length * this.msPerWord);
    const wav = buildSilenceWav(durationMs);
    await writeFile(input.outputPath, wav);
    const result: TTSResult = { audioPath: input.outputPath, durationMs };
    if (this.withTimings) {
      const timings: WordTiming[] = [];
      let cursor = 0;
      for (const w of words) {
        timings.push({ word: w, startMs: cursor, endMs: cursor + this.msPerWord });
        cursor += this.msPerWord;
      }
      result.wordTimings = timings;
    }
    return result;
  }
}
