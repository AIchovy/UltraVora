import { writeFile } from "node:fs/promises";
import type { MusicInput, MusicProvider, MusicResult } from "./types.js";

/**
 * Minimal structural type for the subset of @google/genai we use. Tests inject a
 * fake matching this shape; production wiring passes a real `new GoogleGenAI(...)`.
 *
 * Follows the documented Lyria 3 music API
 * (https://ai.google.dev/gemini-api/docs/music-generation): a standard
 * client.models.generateContent call (NOT a live/streaming session) that returns
 * the audio as base64 inlineData. Models: "lyria-3-pro-preview" (multi-minute,
 * can emit WAV) and "lyria-3-clip-preview" (30s, MP3 only). 44.1 kHz stereo.
 */
export interface GeminiMusicClient {
  models: {
    generateContent: (
      opts: { model: string; contents: unknown; config?: unknown } | unknown,
    ) => Promise<{
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; text?: string }> };
      }>;
    }>;
  };
}

export interface GeminiMusicProviderOptions {
  apiKey: string;
  /** Optional client override for tests. Production creates a real GoogleGenAI from apiKey. */
  client?: GeminiMusicClient;
  /** Model id; default is Lyria 3 Pro (multi-minute, WAV-capable). Override as needed. */
  model?: string;
}

export class GeminiMusicProvider implements MusicProvider {
  readonly id = "gemini";
  private clientOrNull: GeminiMusicClient | null;
  private apiKey: string;
  private model: string;

  constructor(opts: GeminiMusicProviderOptions) {
    this.clientOrNull = opts.client ?? null;
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "lyria-3-pro-preview";
  }

  private async getClient(): Promise<GeminiMusicClient> {
    if (this.clientOrNull) return this.clientOrNull;
    const mod = await import("@google/genai");
    const GoogleGenAI = (mod as unknown as { GoogleGenAI: new (o: { apiKey: string }) => unknown })
      .GoogleGenAI;
    const client = new GoogleGenAI({ apiKey: this.apiKey }) as unknown as GeminiMusicClient;
    this.clientOrNull = client;
    return client;
  }

  async generate(input: MusicInput): Promise<MusicResult> {
    if (input.signal?.aborted) throw new Error("Aborted");

    // Lyria has no duration parameter — steer length via the prompt text.
    const prompt = `${input.prompt}\n\nMake the track approximately ${Math.round(input.durationSec)} seconds long.`;
    const request = {
      model: this.model,
      contents: prompt,
      config: {
        responseModalities: ["AUDIO", "TEXT"],
        // Lyria 3 Pro can emit WAV; ignored (MP3) by clip models.
        responseFormat: { audio: { mimeType: "audio/wav" } },
      },
    };
    const client = await this.getClient();
    const response = await client.models.generateContent(request);
    const inlineData = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!inlineData?.data) {
      throw new Error("Gemini music generation returned no audio inline data");
    }
    const bytes = Buffer.from(inlineData.data, "base64");
    await writeFile(input.outputPath, bytes);
    return {
      audioPath: input.outputPath,
      mimeType: inlineData.mimeType ?? "audio/wav",
    };
  }
}
