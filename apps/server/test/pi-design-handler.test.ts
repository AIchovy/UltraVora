import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import type { ImageProvider, ImageInput, ImageResult } from "../src/providers/types.js";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";
import { PiDesignPhaseHandler } from "../src/phases/pi-design-handler.js";

let root: string;
let faux: FauxProviderRegistration;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-pi-design-"));
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
  palette: [{ name: "primary", hex: "#FF3366" }],
  colorRoles: { background: "#101018", foreground: "#F5F5F7", accent: "#FF3366" },
  typography: { heading: "Space Grotesk", body: "Fraunces" },
  motionStyle: "kinetic captions",
  keyVisuals: [{ description: "product hero" }],
  sampleFrames: [{ caption: "Meet Acme", layoutHint: "centered" }],
};

describe("PiDesignPhaseHandler", () => {
  it("writes a design v1 derived from brief v1 when the agent calls write_design", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_design", designData)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", briefData);

    const handler = new PiDesignPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test")!,
    });

    for await (const _ of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      signal: new AbortController().signal,
    })) {
      // drain
    }

    const list = await store.list("s1");
    const design = list.find((d) => d.kind === "design");
    expect(design).toMatchObject({ version: 1 });
    expect(design!.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
  });

  it("attaches the logo and capture screenshots as image blocks on the design prompt", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({
      create: { width: 80, height: 40, channels: 3, background: { r: 200, g: 30, b: 40 } },
    }).png().toBuffer();

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    const p = workspaces.paths("s1");
    await writeFile(join(p.assets, "logo.png"), png);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(p.root, "capture", "screenshots"), { recursive: true });
    await writeFile(join(p.root, "capture", "screenshots", "screenshot-01.jpg"), png);

    await store.put("s1", "brief", {
      ...briefData,
      brandHints: { colors: ["#000"], logoFile: "assets/logo.png" },
    });

    let imageBlocks = -1;
    faux.setResponses([
      (context) => {
        const user = context.messages.find((m: any) => m.role === "user") as any;
        imageBlocks = Array.isArray(user?.content)
          ? user.content.filter((c: any) => c.type === "image").length
          : 0;
        return fauxAssistantMessage(fauxToolCall("write_design", designData));
      },
      fauxAssistantMessage(fauxText("done")),
    ]);

    const handler = new PiDesignPhaseHandler({
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

    expect(imageBlocks).toBe(2); // logo + screenshot
  });

  it("derives design v2 from design v1 + brief v1 on a refine pass", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_design", { ...designData, mood: "premium" })),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", briefData);
    await store.put("s1", "design", designData, { derivedFrom: [{ kind: "brief", version: 1 }] });

    const handler = new PiDesignPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test")!,
    });

    for await (const _ of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      refinement: "Make it more premium.",
      signal: new AbortController().signal,
    })) { /* drain */ }

    const list = await store.list("s1");
    const v2 = list.find((d) => d.kind === "design" && d.version === 2)!;
    expect(v2.derivedFrom).toEqual([
      { kind: "design", version: 1 },
      { kind: "brief", version: 1 },
    ]);
  });

  it("exposes generate_image when an imageProvider is configured, writing into assets/", async () => {
    const PNG = Buffer.from("89504e470d0a1a0a", "hex");
    const calls: ImageInput[] = [];
    const imageProvider: ImageProvider = {
      id: "fake",
      async generate(input: ImageInput): Promise<ImageResult> {
        calls.push(input);
        await writeFile(input.outputPath, PNG);
        return { imagePath: input.outputPath, mimeType: "image/png" };
      },
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("generate_image", { prompt: "a hero shot", aspectRatio: "16:9" })),
      fauxAssistantMessage(fauxToolCall("write_design", designData)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", briefData);

    const handler = new PiDesignPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test")!,
      imageProvider,
    });

    for await (const _ of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe("a hero shot");
    expect(readdirSync(workspaces.paths("s1").assets)).toHaveLength(1);
    const file = readdirSync(workspaces.paths("s1").assets)[0]!;
    expect(file).toMatch(/\.png$/);
    expect(existsSync(join(workspaces.paths("s1").assets, file))).toBe(true);
    // The design artifact is still written.
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "design")).toBeDefined();
  });

  it("recovers from a transient fetch-failed turn and still writes the design (prod session 238388c4 regression)", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "fetch failed" }),
      fauxAssistantMessage(fauxToolCall("write_design", designData)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", briefData);

    const handler = new PiDesignPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test")!,
      retry: { baseDelayMs: 1 },
    });

    const events: import("@ultracreator/shared").ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }

    expect(
      events.some((e) => e.type === "phase.progress" && /Transient error/.test(e.message)),
    ).toBe(true);
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "design")).toMatchObject({ version: 1 });
  });
});
