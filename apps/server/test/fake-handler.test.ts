import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { FakePhaseHandler } from "../src/phases/fake-handler.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-fh-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("FakePhaseHandler", () => {
  it("yields progress events then writes artifacts via the store", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await wm.init("s1");

    const briefData = {
      product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
      audience: "devs",
      keyMessages: ["fast"],
      brandHints: { colors: ["#000"] },
      sourceAssets: { images: [], videos: [], copy: [] },
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    };

    const handler = new FakePhaseHandler({
      phase: "research",
      progress: ["fetching", "summarizing"],
      produce: async () => [{ kind: "brief", data: briefData }],
    });

    const events: ServerEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));

    const yielded: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1",
      workspaces: wm,
      artifacts: store,
      events: bus,
      signal: new AbortController().signal,
    })) {
      yielded.push(e);
    }

    expect(yielded).toEqual([
      { type: "phase.progress", phase: "research", message: "fetching" },
      { type: "phase.progress", phase: "research", message: "summarizing" },
    ]);
    expect(events).toContainEqual({ type: "artifact.created", kind: "brief", version: 1 });
  });

  it("throws if produce() returns an artifact whose schema is invalid", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await wm.init("s1");

    const handler = new FakePhaseHandler({
      phase: "design",
      produce: async () => [{ kind: "design", data: { mood: "x" } /* missing required fields */ }],
    });

    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1",
        workspaces: wm,
        artifacts: store,
        events: bus,
        signal: new AbortController().signal,
      })) { /* drain */ }
    }).rejects.toThrow();
  });

  it("respects abort: throws if signal is aborted before produce()", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await wm.init("s1");

    const controller = new AbortController();
    controller.abort();

    const handler = new FakePhaseHandler({
      phase: "research",
      produce: async () => [],
    });

    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1",
        workspaces: wm,
        artifacts: store,
        events: bus,
        signal: controller.signal,
      })) { /* drain */ }
    }).rejects.toThrow(/abort/i);
  });
});
