import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Type } from "typebox";
import { getModel, registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";

let faux: FauxProviderRegistration;
beforeEach(() => {
  faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
});
afterEach(() => {
  faux.unregister();
});

describe("PiAgentFactory", () => {
  it("creates an Agent that runs to completion against a faux model", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("done"))]);

    const factory = new PiAgentFactory();
    const agent = factory.create({
      systemPrompt: "test",
      tools: [],
      model: faux.getModel("uc-test")!,
      signal: new AbortController().signal,
    });
    await agent.prompt("hi");
    const last = agent.state.messages[agent.state.messages.length - 1]!;
    expect(JSON.stringify(last)).toContain("done");
  });

  it("invokes a registered tool when the assistant message asks for it", async () => {
    let toolCalled = false;
    const echoTool: AgentTool = {
      name: "echo",
      label: "Echo",
      description: "Echo a value",
      parameters: Type.Object({ value: Type.String() }),
      execute: async (_id, params) => {
        toolCalled = true;
        return { content: [{ type: "text", text: String((params as { value: string }).value) }], details: {} };
      },
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { value: "ping" })),
      fauxAssistantMessage(fauxText("ok")),
    ]);

    const factory = new PiAgentFactory();
    const agent = factory.create({
      systemPrompt: "test",
      tools: [echoTool],
      model: faux.getModel("uc-test")!,
      signal: new AbortController().signal,
    });
    await agent.prompt("call echo");
    expect(toolCalled).toBe(true);
  });

  it("calls agent.abort() when the external signal aborts after create", () => {
    // We intercept the bound method to observe — the Agent has no public hook for "did abort fire?".
    const factory = new PiAgentFactory();
    const controller = new AbortController();
    const agent = factory.create({
      systemPrompt: "test",
      tools: [],
      model: faux.getModel("uc-test")!,
      signal: controller.signal,
    });
    let aborted = false;
    const original = agent.abort.bind(agent);
    agent.abort = () => {
      aborted = true;
      original();
    };
    controller.abort();
    expect(aborted).toBe(true);
  });

  it("uses a supported thinking level for Gemini 3.8 Flash", () => {
    const agent = new PiAgentFactory().create({
      systemPrompt: "test",
      tools: [],
      model: getModel("google", "gemini-3.8-flash"),
      signal: new AbortController().signal,
    });

    expect(agent.state.thinkingLevel).toBe("low");
  });
});
