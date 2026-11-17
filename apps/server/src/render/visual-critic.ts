import { z } from "zod";
import type { Design, Script } from "@ultracreator/shared";
import { imageContentFromFile } from "../tools/image-content.js";
import type { CapturedCriticFrame } from "./snapshot-runner.js";
import { COMMERCIAL_ICONOGRAPHY_PROMPT } from "./iconography-check.js";

const VisualIssueSchema = z.object({
  sceneId: z.string(),
  category: z.enum([
    "hierarchy", "webpage_like", "brand_fidelity", "repetition", "cheap_effect",
    "asset_use", "transition", "readability", "composition",
  ]),
  severity: z.enum(["high", "medium"]),
  note: z.string(),
  fix: z.string(),
});

const VisualVerdictSchema = z.object({
  score: z.number().min(0).max(100),
  summary: z.string(),
  issues: z.array(VisualIssueSchema).max(10),
});

export type VisualVerdict = z.infer<typeof VisualVerdictSchema> & { ok: boolean };

export interface VisualCriticInput {
  frames: CapturedCriticFrame[];
  script: Script;
  design: Design;
  signal: AbortSignal;
}

export interface VisualCritic {
  critique(input: VisualCriticInput): Promise<VisualVerdict>;
}

export interface GeminiVisualCriticClient {
  models: {
    generateContent(opts: unknown): Promise<{
      text?: string;
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }>;
  };
}

export interface GeminiVisualCriticOptions {
  apiKey: string;
  client?: GeminiVisualCriticClient;
  model?: string;
  passScore?: number;
}

export class GeminiVisualCritic implements VisualCritic {
  private clientOrNull: GeminiVisualCriticClient | null;
  private readonly model: string;
  private readonly passScore: number;

  constructor(private opts: GeminiVisualCriticOptions) {
    this.clientOrNull = opts.client ?? null;
    this.model = opts.model ?? "gemini-3.1-flash-lite-preview";
    this.passScore = opts.passScore ?? 78;
  }

  private async client(): Promise<GeminiVisualCriticClient> {
    if (this.clientOrNull) return this.clientOrNull;
    const mod = await import("@google/genai");
    const GoogleGenAI = (mod as unknown as { GoogleGenAI: new (o: { apiKey: string }) => unknown }).GoogleGenAI;
    this.clientOrNull = new GoogleGenAI({ apiKey: this.opts.apiKey }) as unknown as GeminiVisualCriticClient;
    return this.clientOrNull;
  }

  async critique(input: VisualCriticInput): Promise<VisualVerdict> {
    const parts: unknown[] = [{ text: [
      "You are a senior commercial promo-film creative director doing a strict contact-sheet review.",
      COMMERCIAL_ICONOGRAPHY_PROMPT,
      "Report added emoji/sticker graphics and mismatched icon families as high-severity cheap_effect issues.",
      "Judge the supplied rendered frames as a sequence, not as isolated web screenshots.",
      "Commercial bar: immediate focal hierarchy; intentional camera/shot variation; 3-layer depth;",
      "brand-specific art direction; visual continuity without repetitive templates; readable large type;",
      "effects that punctuate meaning instead of looking like presets; assets integrated as hero material;",
      "a clear escalation and memorable CTA. Penalize centered webpage/card-grid/slide-deck composition,",
      "generic gradients, repeated entrance/layout recipes, arbitrary glow/glitch, weak negative space,",
      "and scenes whose build/hero/resolve samples do not show a meaningful visual progression.",
      "Only report medium/high issues that can be fixed in HTML/CSS/GSAP. Be specific: identify what to",
      "change, where, and what the intended result should be. Return JSON only.",
      `Design: ${JSON.stringify(input.design)}`,
      `Script/director plan: ${JSON.stringify(input.script)}`,
      "Frame labels follow immediately before each image.",
    ].join("\n") }];
    for (const frame of input.frames) {
      const image = await imageContentFromFile(frame.path, { maxDim: 1280, quality: 76 });
      if (!image) continue;
      parts.push({ text: `scene=${frame.sceneId}; moment=${frame.moment}; t=${frame.timeSec}s` });
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }
    const response = await (await this.client()).models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts }],
      config: {
        temperature: 0.15,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          required: ["score", "summary", "issues"],
          properties: {
            score: { type: "number", minimum: 0, maximum: 100 },
            summary: { type: "string" },
            issues: {
              type: "array", maxItems: 10,
              items: {
                type: "object",
                required: ["sceneId", "category", "severity", "note", "fix"],
                properties: {
                  sceneId: { type: "string" },
                  category: {
                    type: "string",
                    enum: [
                      "hierarchy", "webpage_like", "brand_fidelity", "repetition",
                      "cheap_effect", "asset_use", "transition", "readability", "composition",
                    ],
                  },
                  severity: { type: "string", enum: ["high", "medium"] },
                  note: { type: "string" },
                  fix: { type: "string" },
                },
              },
            },
          },
        },
        abortSignal: input.signal,
      },
    });
    const text = response.text ?? response.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "").join("");
    if (!text) throw new Error("Visual critic returned no JSON");
    const parsed = VisualVerdictSchema.parse(JSON.parse(text));
    const hasHighIssue = parsed.issues.some((issue) => issue.severity === "high");
    return { ...parsed, ok: parsed.score >= this.passScore && !hasHighIssue };
  }
}
