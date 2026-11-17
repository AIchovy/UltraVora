import { writeFile } from "node:fs/promises";
import type { TTSInput, TTSProvider, TTSResult } from "./types.js";

/**
 * Minimal structural type for the subset of @google/genai we use.
 * Tests inject a fake matching this shape; production wiring passes a real
 * `new GoogleGenAI({ apiKey })`.
 */
export interface GeminiClient {
  models: {
    generateContent: (
      opts:
        | {
            model: string;
            contents: unknown;
            config?: unknown;
          }
        | unknown,
    ) => Promise<{
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { mimeType?: string; data?: string };
            text?: string;
          }>;
        };
      }>;
    }>;
  };
}

export interface GeminiTTSProviderOptions {
  apiKey: string;
  /** Optional client override for tests. Production creates a real GoogleGenAI from apiKey. */
  client?: GeminiClient;
  /** Model id; default is the public Gemini TTS preview model. */
  model?: string;
  /** Default voice for single-speaker requests. */
  defaultVoice?: string;
  /** Emit evenly-spaced approximate word timings spanning the audio duration. Default false. */
  approximateWordTimings?: boolean;
}

const SAMPLE_RATE = 24000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;

function wrapPcmAsWav(pcm: Buffer): Buffer {
  const dataSize = pcm.length;
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(NUM_CHANNELS, 22);
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 28);
  out.writeUInt16LE(NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 32);
  out.writeUInt16LE(BITS_PER_SAMPLE, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataSize, 40);
  pcm.copy(out, 44);
  return out;
}

function durationMsFromPcm(pcm: Buffer): number {
  const samples = pcm.length / (NUM_CHANNELS * (BITS_PER_SAMPLE / 8));
  return Math.round((samples / SAMPLE_RATE) * 1000);
}

export class GeminiTTSProvider implements TTSProvider {
  readonly id = "gemini";
  private clientOrNull: GeminiClient | null;
  private apiKey: string;
  private model: string;
  private defaultVoice: string;
  private approximateWordTimings: boolean;

  constructor(opts: GeminiTTSProviderOptions) {
    this.clientOrNull = opts.client ?? null;
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "gemini-2.5-flash-preview-tts";
    this.defaultVoice = opts.defaultVoice ?? "Kore";
    this.approximateWordTimings = opts.approximateWordTimings ?? false;
  }

  private async getClient(): Promise<GeminiClient> {
    if (this.clientOrNull) return this.clientOrNull;
    const mod = await import("@google/genai");
    const GoogleGenAI = (mod as unknown as { GoogleGenAI: new (o: { apiKey: string }) => unknown })
      .GoogleGenAI;
    const client = new GoogleGenAI({ apiKey: this.apiKey }) as unknown as GeminiClient;
    this.clientOrNull = client;
    return client;
  }

  async synthesize(input: TTSInput): Promise<TTSResult> {
    if (input.signal?.aborted) throw new Error("Aborted");

    const voiceName = input.voice ?? this.defaultVoice;
    // Gemini TTS takes delivery direction as a natural-language prefix in the
    // prompt ("Say cheerfully: …") — the model interprets it, it is not spoken.
    const promptText = input.styleInstruction
      ? `${input.styleInstruction}:\n\n${input.text}`
      : input.text;
    const request = {
      model: this.model,
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
      },
    };
    const client = await this.getClient();
    const response = await client.models.generateContent(request);
    const inlineData = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!inlineData?.data) {
      throw new Error("Gemini TTS returned no audio inline data");
    }
    const pcm = Buffer.from(inlineData.data, "base64");
    const wav = wrapPcmAsWav(pcm);
    await writeFile(input.outputPath, wav);
    const result: TTSResult = {
      audioPath: input.outputPath,
      durationMs: durationMsFromPcm(pcm),
    };
    if (this.approximateWordTimings) {
      const words = input.text.split(/\s+/).filter(Boolean);
      if (words.length > 0) {
        const per = result.durationMs / words.length;
        result.wordTimings = words.map((word, i) => ({
          word,
          startMs: Math.round(i * per),
          endMs: Math.round((i + 1) * per),
        }));
      }
    }
    return result;
  }
}
