import {
  Agent,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";

export interface PiAgentFactoryOptions {
  systemPrompt: string;
  tools: AgentTool[];
  model: Model<any>;
  signal: AbortSignal;
}

export interface PiHarnessFactoryOptions {
  /** System prompt — string, or a callback that can fold in resources (e.g. the skill listing). */
  systemPrompt: string | (() => string);
  tools: AgentTool[];
  model: Model<any>;
  signal: AbortSignal;
}

export interface PiAgentFactoryConstructorOptions {
  /**
   * Optional API key resolver injected by the server bootstrap.
   * When provided, the agent will call this function to obtain an API key
   * for a given provider before each LLM request.
   */
  getApiKey?: (provider: string) => string | undefined;
}

/**
 * Wraps `Agent` construction for a single phase run.
 *
 * The factory:
 * - Builds the agent with the supplied system prompt, model, and tools.
 * - Bridges the orchestrator's `AbortSignal` to `agent.abort()` so abort is
 *   honored mid-run.
 * - Wires a `convertToLlm` that passes standard LLM messages through unchanged
 *   (we don't use custom AgentMessage types in Plan 3).
 * - If constructed with `getApiKey`, forwards it to the agent so the provider
 *   can obtain an API key per request (required for providers like Anthropic).
 */
export class PiAgentFactory {
  private readonly getApiKey?: (provider: string) => string | undefined;

  constructor(opts: PiAgentFactoryConstructorOptions = {}) {
    this.getApiKey = opts.getApiKey;
  }

  create(opts: PiAgentFactoryOptions): Agent {
    const agent = new Agent({
      initialState: {
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        tools: opts.tools,
        ...(opts.model.provider === "google" && opts.model.id === "gemini-3.8-flash"
          ? { thinkingLevel: "low" as const }
          : {}),
      },
      streamFn: streamSimple,
      // Plan 3 does not register any custom AgentMessage types, so every
      // message in the transcript is already an LLM `Message`. Cast to satisfy
      // the union type without runtime filtering.
      convertToLlm: (messages) => messages as Message[],
      // Forward the API key resolver if one was injected at construction time.
      ...(this.getApiKey ? { getApiKey: this.getApiKey } : {}),
    });

    if (opts.signal.aborted) {
      agent.abort();
    } else {
      const onAbort = () => agent.abort();
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    return agent;
  }

  /** Build the stateful compose agent used across author/review/re-author turns. */
  createHarness(opts: PiHarnessFactoryOptions): Agent {
    const getApiKey = this.getApiKey;
    const harness = new Agent({
      initialState: {
        systemPrompt: typeof opts.systemPrompt === "function" ? opts.systemPrompt() : opts.systemPrompt,
        model: opts.model,
        tools: opts.tools,
        // Gemini 3.8 does not accept the MINIMAL thinking level that Pi uses
        // when reasoning is disabled; LOW is the least-supported level.
        ...(opts.model.provider === "google" && opts.model.id === "gemini-3.8-flash"
          ? { thinkingLevel: "low" as const }
          : {}),
      },
      streamFn: streamSimple,
      convertToLlm: (messages) => messages as Message[],
      ...(getApiKey ? { getApiKey } : {}),
    });

    const abort = () => harness.abort();
    if (opts.signal.aborted) {
      abort();
    } else {
      opts.signal.addEventListener("abort", abort, { once: true });
    }

    return harness;
  }
}
