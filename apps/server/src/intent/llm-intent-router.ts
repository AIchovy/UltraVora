import type { Context, Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { z } from "zod";
import { INTENTS, PHASE_IDS, type UserMessage } from "@ultracreator/shared";
import type { ClassifiedIntent, IntentRouter, RouterState } from "./intent-router.js";

/**
 * Structural subset of pi-ai's `complete()` — narrow enough for tests to fake
 * without building a full AssistantMessage.
 */
export type CompleteFn = (
  model: Model<any>,
  context: Context,
  options?: {
    apiKey?: string;
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
  },
) => Promise<{
  content: ReadonlyArray<{ type: string; text?: string }>;
  stopReason: string;
  errorMessage?: string;
}>;

const LLMIntentSchema = z.object({
  intent: z.enum(INTENTS),
  targetPhase: z.enum(PHASE_IDS).optional(),
});

export interface LLMIntentRouterOptions {
  model: Model<any>;
  /** Used when the LLM call fails, times out, or returns unusable output. */
  fallback: IntentRouter;
  getApiKey?: (provider: string) => string | undefined;
  /** Injectable for tests; defaults to pi-ai's `complete`. */
  completeFn?: CompleteFn;
  /** Default 10s — classification must never stall the message queue for long. */
  timeoutMs?: number;
}

/**
 * Classifies user messages with one LLM completion per message. Slash
 * commands and structural signals (idle + constraints) short-circuit
 * deterministically; every failure mode falls back to the rule router, so
 * this class never throws from `classify`.
 */
export class LLMIntentRouter implements IntentRouter {
  private readonly model: Model<any>;
  private readonly fallback: IntentRouter;
  private readonly getApiKey?: (provider: string) => string | undefined;
  private readonly completeFn: CompleteFn;
  private readonly timeoutMs: number;

  constructor(opts: LLMIntentRouterOptions) {
    this.model = opts.model;
    this.fallback = opts.fallback;
    this.getApiKey = opts.getApiKey;
    this.completeFn = opts.completeFn ?? (complete as CompleteFn);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async classify(message: UserMessage, state: RouterState): Promise<ClassifiedIntent> {
    // Explicit commands stay deterministic regardless of LLM availability.
    if (message.text.trim().startsWith("/")) {
      return this.fallback.classify(message, state);
    }
    // First message from the composer carries constraints — a structural
    // signal, not a linguistic one.
    if (state.kind === "idle" && message.constraints !== undefined) {
      return { intent: "new-project" };
    }
    try {
      return await this.classifyWithLLM(message, state);
    } catch {
      return this.fallback.classify(message, state);
    }
  }

  private async classifyWithLLM(message: UserMessage, state: RouterState): Promise<ClassifiedIntent> {
    const context: Context = {
      systemPrompt: buildSystemPrompt(state),
      messages: [{ role: "user", content: message.text, timestamp: Date.now() }],
    };
    const apiKey = this.getApiKey?.(this.model.provider);
    const response = await this.withTimeout((signal) =>
      this.completeFn(this.model, context, {
        signal,
        maxTokens: 200,
        temperature: 0,
        ...(apiKey ? { apiKey } : {}),
      }),
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? `LLM stopReason "${response.stopReason}"`);
    }
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
    const parsed = LLMIntentSchema.parse(JSON.parse(extractJson(text)));
    // targetPhase only carries meaning for revise-back.
    if (parsed.intent === "revise-back") {
      return { intent: parsed.intent, ...(parsed.targetPhase ? { targetPhase: parsed.targetPhase } : {}) };
    }
    return { intent: parsed.intent };
  }

  /**
   * Races the request against a hard timer AND aborts the underlying request.
   * The race matters because a misbehaving transport may ignore the signal.
   */
  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`intent classification timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([fn(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildSystemPrompt(state: RouterState): string {
  return [
    "You classify one user chat message from a video-creation session into exactly one intent.",
    "",
    `Pipeline phases in order: ${PHASE_IDS.join(", ")}.`,
    `Current session state: kind=${state.kind}${state.phase ? `, phase=${state.phase}` : ""}.`,
    "",
    "Intents:",
    '- "new-project": start a new video project (only meaningful when kind=idle).',
    '- "approve": accept the current result and continue (only meaningful when kind=awaiting-gate).',
    '- "refine": adjust or re-run the CURRENT phase. Retry/redo requests after a failure (kind=error) are refine. When the video is finished (kind=done), ANY requested change to the video ("make the headline blue", "shorten the ending") is refine — the system revises the composition and re-renders.',
    '- "revise-back": go back to an EARLIER phase and redo from there; set targetPhase.',
    '- "update-brief": change global constraints (duration, aspect ratio, voiceover, audience).',
    '- "branch": explicitly fork an alternative version.',
    '- "abort": stop or cancel the current run.',
    '- "ask": a question or chatter that requires none of the above actions. A bare acknowledgement or thanks ("thanks", "looks great", "太棒了") — especially after the video is done — is ask, NOT refine: a refine re-generates the video and charges the user.',
    "",
    'The message may be in any language (e.g. Chinese "重试" means retry).',
    'Reply with ONLY a JSON object, no prose: {"intent":"<intent>"} or {"intent":"revise-back","targetPhase":"<phase>"}.',
  ].join("\n");
}

function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}
