import { describe, it, expect } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { selectIntentRouter } from "../src/compose-orchestrator.js";
import { RuleBasedIntentRouter } from "../src/intent/intent-router.js";
import { LLMIntentRouter } from "../src/intent/llm-intent-router.js";

const anthropicModel = { provider: "anthropic", id: "claude-test" } as unknown as Model<any>;
const googleModel = { provider: "google", id: "gemini-test" } as unknown as Model<any>;

describe("selectIntentRouter", () => {
  it("uses the explicit override when provided", () => {
    const override = new RuleBasedIntentRouter();
    const router = selectIntentRouter({ model: anthropicModel, intentRouterOverride: override });
    expect(router).toBe(override);
  });

  it("returns the rule router when no API key matches the model provider", () => {
    const router = selectIntentRouter({ model: anthropicModel, geminiApiKey: "g-key" });
    expect(router).toBeInstanceOf(RuleBasedIntentRouter);
  });

  it("returns the LLM router when the model provider has a key", () => {
    const router = selectIntentRouter({ model: anthropicModel, anthropicApiKey: "a-key" });
    expect(router).toBeInstanceOf(LLMIntentRouter);
  });

  it("prefers intentModel over the main model", () => {
    const router = selectIntentRouter({
      model: anthropicModel,
      intentModel: googleModel,
      geminiApiKey: "g-key",
    });
    expect(router).toBeInstanceOf(LLMIntentRouter);
  });
});
