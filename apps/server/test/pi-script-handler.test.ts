import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";
import { PiScriptPhaseHandler, SYSTEM_PROMPT } from "../src/phases/pi-script-handler.js";

let root: string;
let faux: FauxProviderRegistration;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-pi-script-"));
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
const designData = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades",
  keyVisuals: [],
  sampleFrames: [],
};

describe("PiScriptPhaseHandler", () => {
  it("requires a persistent director plan instead of a layout-only visual note", () => {
    expect(SYSTEM_PROMPT).toContain("productionPlan");
    expect(SYSTEM_PROMPT).toContain("rhythmPattern");
    expect(SYSTEM_PROMPT).toContain("effectSlots");
    expect(SYSTEM_PROMPT).toContain("SFX cues");
  });

  it("writes a script derived from design+brief when the agent calls write_script", async () => {
    const scriptOutput = {
      totalSec: 30,
      scenes: [
        {
          id: "s1",
          startSec: 0,
          durationSec: 6,
          visual: "logo reveal",
          // ~14 words ≈ 6s of speech at 2.4 w/s — fits the scene's word budget.
          narration: "Meet Acme, the fastest way to ship your ideas without wrestling your own tools.",
        },
        { id: "s2", startSec: 6, durationSec: 24, visual: "product demo" },
      ],
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_script", scriptOutput)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", briefData);
    await store.put("s1", "design", designData, { derivedFrom: [{ kind: "brief", version: 1 }] });

    const handler = new PiScriptPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test")!,
    });

    for await (const _ of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    const list = await store.list("s1");
    const script = list.find((d) => d.kind === "script")!;
    expect(script.version).toBe(1);
    expect(script.derivedFrom).toEqual([
      { kind: "design", version: 1 },
      { kind: "brief", version: 1 },
    ]);
  });
});
