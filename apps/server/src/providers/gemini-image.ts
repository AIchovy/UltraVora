import { writeFile } from "node:fs/promises";
import type { ImageInput, ImageProvider, ImageResult } from "./types.js";

/**
 * Minimal structural type for the subset of @google/genai we use.
 * Tests inject a fake matching this shape; production wiring passes a real
 * `new GoogleGenAI({ apiKey })`.
 */
export interface GeminiImageClient {
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

export interface GeminiImageProviderOptions {
  apiKey: string;
  /** Optional client override for tests. Production creates a real GoogleGenAI from apiKey. */
  client?: GeminiImageClient;
  /** Model id; default is the Gemini 3.1 image model. */
  model?: string;
}

export class GeminiImageProvider implements ImageProvider {
  readonly id = "gemini";
  private clientOrNull: GeminiImageClient | null;
  private apiKey: string;
  private model: string;

  constructor(opts: GeminiImageProviderOptions) {
    this.clientOrNull = opts.client ?? null;
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "gemini-3.1-flash-image";
  }

  private async getClient(): Promise<GeminiImageClient> {
    if (this.clientOrNull) return this.clientOrNull;
    const mod = await import("@google/genai");
    const GoogleGenAI = (mod as unknown as { GoogleGenAI: new (o: { apiKey: string }) => unknown })
      .GoogleGenAI;
    const client = new GoogleGenAI({ apiKey: this.apiKey }) as unknown as GeminiImageClient;
    this.clientOrNull = client;
    return client;
  }

  async generate(input: ImageInput): Promise<ImageResult> {
    if (input.signal?.aborted) throw new Error("Aborted");

    const config: Record<string, unknown> = {
      responseModalities: ["IMAGE"],
    };
    if (input.aspectRatio) {
      config.imageConfig = { aspectRatio: input.aspectRatio };
    }
    const request = {
      model: this.model,
      contents: [{ role: "user", parts: [{ text: input.prompt }] }],
      config,
    };
    const client = await this.getClient();
    const response = await client.models.generateContent(request);
    const inlineData = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!inlineData?.data) {
      throw new Error("Gemini image generation returned no image inline data");
    }
    const bytes = Buffer.from(inlineData.data, "base64");
    await writeFile(input.outputPath, bytes);
    return {
      imagePath: input.outputPath,
      mimeType: inlineData.mimeType ?? "image/png",
    };
  }
}
