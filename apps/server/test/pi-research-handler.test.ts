import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import type { ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";
import { PiResearchPhaseHandler } from "../src/phases/pi-research-handler.js";

let root: string;
let faux: FauxProviderRegistration;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-pi-research-"));
  faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  faux.unregister();
});

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

describe("PiResearchPhaseHandler", () => {
  it("drives the agent through a write_brief tool call and writes brief v1", async () => {
    // Canned conversation: assistant calls write_brief once, then says "done".
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_brief", briefData)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");

    const handler = new PiResearchPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test")!,
      fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) }),
    });

    const events: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      initialMessage: {
        text: "Make a promo for https://acme.example",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      },
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")).toMatchObject({ version: 1 });
    // The agent ran at least one tool during research (web_fetch), surfaced as a
    // structured tool event rather than a free-text progress line.
    expect(events.some((e) => e.type === "agent.tool_end" && e.phase === "research")).toBe(true);
  });

  it("nudges the agent to call write_brief when the first turn ends with only prose", async () => {
    // The real-world failure: the model fetches the page, then ends its turn with
    // a prose summary instead of calling write_brief — leaving the phase with no
    // artifact. The handler must nudge it; on the retry it complies.
    faux.setResponses([
      fauxAssistantMessage(fauxText("Here is a summary of the product I researched.")),
      fauxAssistantMessage(fauxToolCall("write_brief", briefData)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");

    const handler = new PiResearchPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test")!,
      fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) }),
    });

    for await (const _ of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      initialMessage: { text: "Make a promo for https://acme.example" },
      signal: new AbortController().signal,
    })) { /* drain */ }

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")).toMatchObject({ version: 1 });
  });

  it("throws a clear error when the agent never produces a brief", async () => {
    // The model just keeps talking and never calls write_brief on any attempt.
    faux.setResponses(
      Array.from({ length: 4 }, () => fauxAssistantMessage(fauxText("still just talking"))),
    );

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");

    const handler = new PiResearchPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test")!,
      fetch: async () => ({ status: 200, text: "" }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) }),
    });

    const iterate = async () => {
      for await (const _ of handler.run({
        sessionId: "s1",
        workspaces,
        artifacts: store,
        events: bus,
        initialMessage: { text: "x" },
        signal: new AbortController().signal,
      })) { /* drain */ }
    };

    await expect(iterate()).rejects.toThrow(/did not produce a brief/i);
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")).toBeUndefined();
  });

  it("throws when the LLM turn ends with stopReason error", async () => {
    // pi-agent-core resolves prompt() on a failed request, ending the turn with
    // stopReason "error" instead of rejecting. The handler must surface that as a
    // thrown error rather than completing silently with no brief artifact —
    // otherwise downstream phases fail confusingly with "no brief found".
    faux.setResponses([
      fauxAssistantMessage(fauxText(""), {
        stopReason: "error",
        errorMessage: "401 invalid x-api-key",
      }),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");

    const handler = new PiResearchPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test")!,
      fetch: async () => ({ status: 200, text: "" }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) }),
    });

    const iterate = async () => {
      for await (const _ of handler.run({
        sessionId: "s1",
        workspaces,
        artifacts: store,
        events: bus,
        initialMessage: { text: "x" },
        signal: new AbortController().signal,
      })) {
        // drain
      }
    };

    await expect(iterate()).rejects.toThrow("401 invalid x-api-key");
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")).toBeUndefined();
  });
});

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

describe("PiResearchPhaseHandler download_asset", () => {
  it("exposes download_asset; agent can save a logo into assets/", async () => {
    const faux2 = registerFauxProvider({ models: [{ id: "uc-test-da" }] });
    faux2.setResponses([
      fauxAssistantMessage(fauxToolCall("download_asset", { url: "https://x.com/logo.png" })),
      fauxAssistantMessage(fauxToolCall("write_brief", {
        product: { name: "X", tagline: "t", description: "d", category: "saas" },
        audience: "devs", keyMessages: ["m"],
        brandHints: { colors: ["#000"], logoFile: "assets/PLACEHOLDER" },
        sourceAssets: { images: [], videos: [], copy: [] },
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      })),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await wm.init("s1");

    const handler = new PiResearchPhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux2.getModel("uc-test-da")!,
      fetch: async () => ({ status: 200, text: "<html></html>" }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: PNG }),
    });

    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      initialMessage: { text: "Make a video for https://x.com" },
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    const assetFiles = existsSync(wm.paths("s1").assets);
    expect(assetFiles).toBe(true);
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")).toBeDefined();

    faux2.unregister();
  });
});
