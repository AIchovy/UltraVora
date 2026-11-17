import { describe, it, expect } from "vitest";
import type { Context, Model } from "@earendil-works/pi-ai";
import type { UserMessage } from "@ultracreator/shared";
import type { ClassifiedIntent, IntentRouter, RouterState } from "../src/intent/intent-router.js";
import { LLMIntentRouter, type CompleteFn } from "../src/intent/llm-intent-router.js";

const idle: RouterState = { kind: "idle" };
const errorResearch: RouterState = { kind: "error", phase: "research" };
const gateDesign: RouterState = { kind: "awaiting-gate", phase: "design" };

const msg = (text: string, extras: Partial<UserMessage> = {}): UserMessage => ({ text, ...extras });
const fakeModel = { provider: "anthropic", id: "claude-test" } as unknown as Model<any>;

/** Fallback that records calls and returns a fixed result. */
class RecordingFallback implements IntentRouter {
  calls = 0;
  constructor(private result: ClassifiedIntent = { intent: "ask" }) {}
  async classify(): Promise<ClassifiedIntent> {
    this.calls++;
    return this.result;
  }
}

/** completeFn stub returning a single text block. */
const textResponse = (text: string): ReturnType<CompleteFn> =>
  Promise.resolve({ content: [{ type: "text", text }], stopReason: "stop" });

function build(opts: {
  completeFn?: CompleteFn;
  fallback?: IntentRouter;
  timeoutMs?: number;
} = {}) {
  const fallback = opts.fallback ?? new RecordingFallback();
  let llmCalls = 0;
  const completeFn: CompleteFn = (...args) => {
    llmCalls++;
    return (opts.completeFn ?? (() => textResponse('{"intent":"ask"}')))(...args);
  };
  const router = new LLMIntentRouter({
    model: fakeModel,
    fallback,
    completeFn,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { router, fallback: fallback as RecordingFallback, getLlmCalls: () => llmCalls };
}

describe("LLMIntentRouter: deterministic fast-paths", () => {
  it("delegates slash commands to the fallback without calling the LLM", async () => {
    const fallback = new RecordingFallback({ intent: "abort" });
    const { router, getLlmCalls } = build({ fallback });
    const result = await router.classify(msg("/abort"), gateDesign);
    expect(result).toEqual({ intent: "abort" });
    expect(fallback.calls).toBe(1);
    expect(getLlmCalls()).toBe(0);
  });

  it("classifies idle+constraints as new-project without calling the LLM", async () => {
    const { router, fallback, getLlmCalls } = build();
    const result = await router.classify(
      msg("Make a promo", { constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false } }),
      idle,
    );
    expect(result).toEqual({ intent: "new-project" });
    expect(fallback.calls).toBe(0);
    expect(getLlmCalls()).toBe(0);
  });
});

describe("LLMIntentRouter: LLM classification", () => {
  it("parses a bare JSON intent from the model", async () => {
    const { router, fallback } = build({
      completeFn: () => textResponse('{"intent":"refine"}'),
    });
    const result = await router.classify(msg("重试"), errorResearch);
    expect(result).toEqual({ intent: "refine" });
    expect(fallback.calls).toBe(0);
  });

  it("parses a code-fenced JSON intent", async () => {
    const { router } = build({
      completeFn: () => textResponse('```json\n{"intent":"approve"}\n```'),
    });
    const result = await router.classify(msg("看起来不错,继续"), gateDesign);
    expect(result).toEqual({ intent: "approve" });
  });

  it("keeps targetPhase for revise-back", async () => {
    const { router } = build({
      completeFn: () => textResponse('{"intent":"revise-back","targetPhase":"script"}'),
    });
    const result = await router.classify(msg("回到脚本阶段重写"), gateDesign);
    expect(result).toEqual({ intent: "revise-back", targetPhase: "script" });
  });

  it("drops targetPhase for non-revise-back intents", async () => {
    const { router } = build({
      completeFn: () => textResponse('{"intent":"refine","targetPhase":"design"}'),
    });
    const result = await router.classify(msg("warmer colors"), gateDesign);
    expect(result).toEqual({ intent: "refine" });
  });

  it("sends state and message to the model and resolves the api key", async () => {
    let capturedContext: Context | undefined;
    let capturedOptions: Parameters<CompleteFn>[2];
    const router = new LLMIntentRouter({
      model: fakeModel,
      fallback: new RecordingFallback(),
      getApiKey: (provider) => (provider === "anthropic" ? "key-123" : undefined),
      completeFn: (_m, context, options) => {
        capturedContext = context;
        capturedOptions = options;
        return textResponse('{"intent":"refine"}');
      },
    });
    await router.classify(msg("重试"), errorResearch);
    expect(capturedContext?.systemPrompt).toContain("kind=error");
    expect(capturedContext?.systemPrompt).toContain("phase=research");
    expect(capturedContext?.messages).toHaveLength(1);
    expect(capturedContext?.messages[0]).toMatchObject({ role: "user", content: "重试" });
    expect(capturedOptions?.apiKey).toBe("key-123");
  });
});

describe("LLMIntentRouter: fallback paths", () => {
  it("falls back when the model returns non-JSON", async () => {
    const fallback = new RecordingFallback({ intent: "refine" });
    const { router } = build({ fallback, completeFn: () => textResponse("I think you want a retry.") });
    expect(await router.classify(msg("重试"), errorResearch)).toEqual({ intent: "refine" });
    expect(fallback.calls).toBe(1);
  });

  it("falls back when the model returns an unknown intent", async () => {
    const fallback = new RecordingFallback({ intent: "refine" });
    const { router } = build({ fallback, completeFn: () => textResponse('{"intent":"retry"}') });
    expect(await router.classify(msg("重试"), errorResearch)).toEqual({ intent: "refine" });
    expect(fallback.calls).toBe(1);
  });

  it("falls back when the request rejects", async () => {
    const fallback = new RecordingFallback({ intent: "refine" });
    const { router } = build({ fallback, completeFn: () => Promise.reject(new Error("ECONNREFUSED")) });
    expect(await router.classify(msg("重试"), errorResearch)).toEqual({ intent: "refine" });
    expect(fallback.calls).toBe(1);
  });

  it("falls back when the model reports stopReason error", async () => {
    const fallback = new RecordingFallback({ intent: "refine" });
    const { router } = build({
      fallback,
      completeFn: () => Promise.resolve({ content: [], stopReason: "error", errorMessage: "overloaded" }),
    });
    expect(await router.classify(msg("重试"), errorResearch)).toEqual({ intent: "refine" });
    expect(fallback.calls).toBe(1);
  });

  it("falls back on timeout and aborts the request", async () => {
    const fallback = new RecordingFallback({ intent: "refine" });
    let aborted = false;
    const { router } = build({
      fallback,
      timeoutMs: 20,
      completeFn: (_m, _c, options) =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    expect(await router.classify(msg("重试"), errorResearch)).toEqual({ intent: "refine" });
    expect(fallback.calls).toBe(1);
    expect(aborted).toBe(true);
  });
});
