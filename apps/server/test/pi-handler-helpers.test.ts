import { describe, it, expect, afterEach } from "vitest";
import {
  registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall,
  type FauxProviderRegistration, type Model,
} from "@earendil-works/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import type { ServerEvent } from "@ultracreator/shared";
import {
  toolLabel, summarizeArgs, summarizeResult,
  runAgentToCompletion, runHarnessToCompletion, runAgentForArtifact,
} from "../src/phases/pi-handler-helpers.js";

describe("toolLabel", () => {
  it("title-cases an unknown underscore tool name as a fallback", () => {
    expect(toolLabel("some_new_tool")).toBe("Some New Tool");
  });
});

describe("summarizeArgs", () => {
  it("shows the skill name for a SKILL.md path", () => {
    expect(summarizeArgs({ path: "/srv/skills/hyperframes/SKILL.md" })).toBe("hyperframes");
  });

  it("shows the basename for a referenced skill file", () => {
    expect(summarizeArgs({ path: "/srv/skills/gsap/references/easing.md" })).toBe("easing.md");
  });

  it("shows the basename of a composition file path, never its content", () => {
    const out = summarizeArgs({ path: "scenes/intro.html", content: "<div>secret</div>" });
    expect(out).toBe("intro.html");
  });

  it("shows only the host for a url", () => {
    expect(summarizeArgs({ url: "https://acme.example/products/x?ref=1" })).toBe("acme.example");
  });

  it("shows a trimmed, whitespace-collapsed snippet of a prompt", () => {
    const prompt =
      "A serene  mountain lake\nat golden hour, ultra detailed, cinematic lighting, 4k";
    const out = summarizeArgs({ prompt, aspectRatio: "16:9" })!;
    expect(out.startsWith("A serene mountain lake at golden hour")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out).toContain("…");
    expect(out).not.toContain("\n");
  });

  it("shows an upload filename as-is", () => {
    expect(summarizeArgs({ filename: "logo.png" })).toBe("logo.png");
  });

  it("shows a registry item name", () => {
    expect(summarizeArgs({ name: "macos-notification" })).toBe("macos-notification");
  });

  it("returns undefined for a structured object with no friendly field", () => {
    expect(
      summarizeArgs({ product: { name: "X" }, audience: "devs", keyMessages: [] }),
    ).toBeUndefined();
  });

  it("returns undefined for non-object args", () => {
    expect(summarizeArgs(undefined)).toBeUndefined();
    expect(summarizeArgs("nope")).toBeUndefined();
    expect(summarizeArgs(["a", "b"])).toBeUndefined();
  });
});

describe("summarizeResult", () => {
  it("returns undefined on success, never dumping file content", () => {
    const result = {
      content: [{ type: "text", text: "--- name: hyperframes\ndescription: Create video…" }],
      details: { path: "/x/skills/hyperframes/SKILL.md", kind: "file", bytes: 1234 },
    };
    expect(summarizeResult(result, false)).toBeUndefined();
  });

  it("returns a short reason on error when text is present", () => {
    const result = {
      content: [{ type: "text", text: "Path is outside the skill directories: /etc/passwd" }],
    };
    expect(summarizeResult(result, true)).toBe(
      "Path is outside the skill directories: /etc/passwd",
    );
  });

  it("truncates a long error reason", () => {
    const out = summarizeResult({ content: [{ type: "text", text: "x".repeat(200) }] }, true)!;
    expect(out.length).toBeLessThanOrEqual(81);
    expect(out).toContain("…");
  });

  it("falls back to 'Failed' when an error has no text", () => {
    expect(summarizeResult({}, true)).toBe("Failed");
    expect(summarizeResult(undefined, true)).toBe("Failed");
  });
});

// Regression coverage for prod session 238388c4: a transient network blip
// talking to the LLM (undici's generic "fetch failed") failed the whole
// phase outright with no retry, unlike VoiceoverPhaseHandler which already
// self-heals from the identical error class via withTransientRetry. These
// exercise the REAL Agent/AgentHarness (via PiAgentFactory) against a
// scripted faux provider so the retry decision is proven against actual
// pi-agent-core turn/error semantics, not a hand-rolled fake.
describe("runAgentToCompletion — transient network retry", () => {
  let faux: FauxProviderRegistration | undefined;
  afterEach(() => {
    faux?.unregister();
    faux = undefined;
  });

  function makeAgent(model: Model<string>) {
    return new PiAgentFactory().create({
      systemPrompt: "test",
      tools: [],
      model,
      signal: new AbortController().signal,
    });
  }

  it("retries a transient fetch-failed turn and completes on the next attempt", async () => {
    faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "fetch failed" }),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const agent = makeAgent(faux.getModel("uc-test")!);

    const events: ServerEvent[] = [];
    for await (const e of runAgentToCompletion({
      phase: "design",
      agent,
      prompt: "go",
      retry: { attempts: 3, baseDelayMs: 1 },
    })) {
      events.push(e);
    }

    expect(
      events.some((e) => e.type === "phase.progress" && /Transient error/.test(e.message)),
    ).toBe(true);
    expect(faux.state.callCount).toBe(2);
  });

  it("does not retry a non-transient error", async () => {
    faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "Invalid tool schema" }),
    ]);
    const agent = makeAgent(faux.getModel("uc-test")!);

    await expect(async () => {
      for await (const _e of runAgentToCompletion({
        phase: "design",
        agent,
        prompt: "go",
        retry: { attempts: 3, baseDelayMs: 1 },
      })) {
        /* drain */
      }
    }).rejects.toThrow("Invalid tool schema");
    expect(faux.state.callCount).toBe(1);
  });

  it("throws the last transient error once attempts are exhausted", async () => {
    faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "fetch failed" }),
      fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "fetch failed" }),
    ]);
    const agent = makeAgent(faux.getModel("uc-test")!);

    await expect(async () => {
      for await (const _e of runAgentToCompletion({
        phase: "design",
        agent,
        prompt: "go",
        retry: { attempts: 2, baseDelayMs: 1 },
      })) {
        /* drain */
      }
    }).rejects.toThrow("fetch failed");
    expect(faux.state.callCount).toBe(2);
  });

  it("never starts a turn when the signal is already aborted — not even the first, potentially billable, one", async () => {
    // Regression: the abort check used to run only AFTER a turn failed, so an
    // already-cancelled session still made one full (paid) agent.prompt()
    // round-trip before the abort was ever consulted.
    faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([fauxAssistantMessage(fauxText("done"))]);
    const agent = makeAgent(faux.getModel("uc-test")!);
    const abortedSignal = (() => {
      const c = new AbortController();
      c.abort();
      return c.signal;
    })();

    await expect(async () => {
      for await (const _e of runAgentToCompletion({
        phase: "design",
        agent,
        prompt: "go",
        signal: abortedSignal,
        retry: { attempts: 3, baseDelayMs: 1 },
      })) {
        /* drain */
      }
    }).rejects.toThrow("Aborted");
    expect(faux.state.callCount).toBe(0);
  });

  it("does not start the retried turn once the signal is aborted during the backoff sleep", async () => {
    faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "fetch failed" }),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const agent = makeAgent(faux.getModel("uc-test")!);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    await expect(async () => {
      for await (const _e of runAgentToCompletion({
        phase: "design",
        agent,
        prompt: "go",
        signal: controller.signal,
        retry: { attempts: 3, baseDelayMs: 100 },
      })) {
        /* drain */
      }
    }).rejects.toThrow(/abort/i);
    expect(faux.state.callCount).toBe(1);
  });

  it("preserves an earlier successful tool call across a transient-failure retry, and nudges the model not to repeat it", async () => {
    // Regression: a transient failure can land on the LLM roundtrip immediately
    // AFTER an earlier turn's tool call already succeeded (e.g. a paid
    // generate_image call). The retry re-prompts the SAME agent — its
    // transcript must still contain that tool call/result (no state loss),
    // and the retry nudge must tell the model not to redo it.
    faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    let retryContextJson = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("some_tool", {})),
      fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "fetch failed" }),
      (context) => {
        retryContextJson = JSON.stringify(context.messages);
        return fauxAssistantMessage(fauxText("done"));
      },
    ]);
    const someTool: AgentTool<ReturnType<typeof Type.Object>> = {
      name: "some_tool",
      label: "Some Tool",
      description: "test tool",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "tool ok" }], details: undefined }),
    };
    const agent = new PiAgentFactory().create({
      systemPrompt: "test",
      tools: [someTool],
      model: faux.getModel("uc-test")!,
      signal: new AbortController().signal,
    });

    for await (const _e of runAgentToCompletion({
      phase: "design",
      agent,
      prompt: "go",
      retry: { attempts: 3, baseDelayMs: 1 },
    })) {
      /* drain */
    }

    expect(faux.state.callCount).toBe(3);
    // The retry turn's context still carries the earlier tool call/result.
    expect(retryContextJson).toContain("some_tool");
    expect(retryContextJson).toContain("tool ok");
    // And the nudge itself warns against repeating it.
    expect(retryContextJson).toMatch(/do not repeat/i);
  });
});

describe("runAgentForArtifact — abort handling", () => {
  let faux: FauxProviderRegistration | undefined;
  afterEach(() => {
    faux?.unregister();
    faux = undefined;
  });

  it("does not issue a nudge turn once the signal is aborted after the initial turn", async () => {
    // Regression: the nudge loop (for prose-without-tool-call recovery) never
    // checked the signal itself — it relied on runAgentToCompletion checking
    // internally, which this proves closes the gap: no nudge call is made
    // once the signal is aborted, even though a nudge would otherwise be due.
    faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxText("just some prose, no tool call")),
      fauxAssistantMessage(fauxToolCall("write_design", {})), // would satisfy a nudge if ever reached
    ]);
    const agent = new PiAgentFactory().create({
      systemPrompt: "test",
      tools: [],
      model: faux.getModel("uc-test")!,
      signal: new AbortController().signal,
    });
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    const controller = new AbortController();

    await expect(async () => {
      for await (const e of runAgentForArtifact({
        phase: "design",
        agent,
        prompt: "go",
        artifacts: store,
        sessionId: "s1",
        kind: "design",
        toolName: "write_design",
        signal: controller.signal,
        retry: { attempts: 3, baseDelayMs: 1 },
      })) {
        // Abort right after the initial (tool-less) turn finishes, before the
        // nudge loop's own produced() check runs.
        if (e.type === "agent.text" && e.isFinal) controller.abort();
      }
    }).rejects.toThrow(/abort/i);
    expect(faux.state.callCount).toBe(1); // only the initial turn ran, no nudge
  });
});

describe("runHarnessToCompletion — transient network retry", () => {
  let faux: FauxProviderRegistration | undefined;
  afterEach(() => {
    faux?.unregister();
    faux = undefined;
  });

  async function makeHarness(model: Model<string>) {
    return new PiAgentFactory().createHarness({
      systemPrompt: () => "test",
      tools: [],
      model,
      signal: new AbortController().signal,
    });
  }

  it("retries a transient fetch-failed turn and completes on the next attempt", async () => {
    faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "fetch failed" }),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const harness = await makeHarness(faux.getModel("uc-test")!);

    const events: ServerEvent[] = [];
    for await (const e of runHarnessToCompletion({
      phase: "compose",
      harness,
      prompt: "go",
      retry: { attempts: 3, baseDelayMs: 1 },
    })) {
      events.push(e);
    }

    expect(
      events.some((e) => e.type === "phase.progress" && /Transient error/.test(e.message)),
    ).toBe(true);
    expect(faux.state.callCount).toBe(2);
  });
});
