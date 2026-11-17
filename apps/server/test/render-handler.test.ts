import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, basename, resolve } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { StubRenderWorkerClient } from "../src/render/stub-render-worker.js";
import type { RenderOptions } from "../src/render/render-worker-client.js";
import { RenderPhaseHandler } from "../src/phases/render-handler.js";
import type { Brief, ServerEvent } from "@ultracreator/shared";

const VALID_BRIEF_WITH_SUBTITLES: Brief = {
  product: {
    name: "TestProduct",
    tagline: "A test tagline",
    description: "A test description",
    category: "Software",
  },
  audience: "Developers",
  keyMessages: ["Fast", "Reliable"],
  brandHints: {
    colors: ["#000000"],
    fonts: [],
  },
  sourceAssets: {
    images: [],
    videos: [],
    copy: [],
  },
  constraints: {
    durationSec: 30,
    aspectRatio: "16:9",
    withVoiceover: true,
    subtitles: true,
  },
};

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-rh-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// Seed a composition artifact + an index.html on disk (as the compose phase would).
async function seedComposition(store: ArtifactStore, wm: WorkspaceManager) {
  await wm.init("s1");
  await store.put("s1", "composition", { dir: "composition", entry: "index.html" });
  await writeFile(join(wm.paths("s1").composition, "index.html"), "<html>composed</html>");
}

describe("RenderPhaseHandler", () => {
  it("reads the composition artifact, renders it, and writes the mp4 artifact", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seedComposition(store, wm);

    const worker = new StubRenderWorkerClient({ writeOutput: true });
    const handler = new RenderPhaseHandler({ workerClient: worker });

    const yielded: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) yielded.push(e);

    const mp4Env = await store.get<{ path: string }>("s1", "mp4");
    expect(mp4Env).not.toBeNull();
    // Workspace-relative (like subtitles' srtPath): the absolute worker path
    // goes stale once the local copy is archived to GCS.
    expect(isAbsolute(mp4Env!.data.path)).toBe(false);
    expect(mp4Env!.data.path).toMatch(/^output\/.+\.mp4$/);
    const mp4Abs = resolve(wm.paths("s1").root, mp4Env!.data.path);
    expect(existsSync(mp4Abs)).toBe(true);
    expect(readFileSync(mp4Abs, "utf8")).toContain("STUB-MP4");
    expect(yielded.some((e) => e.type === "render.progress")).toBe(true);
    expect(yielded.at(-1)).toMatchObject({ type: "render.done" });
  });

  it("throws when the upstream composition artifact is missing", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await wm.init("s1");
    // no composition artifact

    const handler = new RenderPhaseHandler({ workerClient: new StubRenderWorkerClient({ writeOutput: true }) });
    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
        signal: new AbortController().signal,
      } as any)) { /* drain */ }
    }).rejects.toThrow(/composition/i);
  });

  it("throws when the worker yields an error and writes no mp4 artifact", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seedComposition(store, wm);

    const worker = new StubRenderWorkerClient({ failWith: "ffmpeg blew up" });
    const handler = new RenderPhaseHandler({ workerClient: worker });

    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
        signal: new AbortController().signal,
      } as any)) { /* drain */ }
    }).rejects.toThrow(/ffmpeg/);

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "mp4")).toBeUndefined();
  });

  it("surfaces a `queued` worker message as a chat notice, not a render.progress", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seedComposition(store, wm);

    class QueuedThenDoneClient extends StubRenderWorkerClient {
      override async *render(opts: RenderOptions) {
        yield { type: "queued", position: 2 } as const;
        yield { type: "done", mp4Path: opts.outputPath } as const;
      }
    }
    const handler = new RenderPhaseHandler({ workerClient: new QueuedThenDoneClient({ writeOutput: true }) });
    const yielded: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) yielded.push(e);

    const notice = yielded.find(
      (e) => e.type === "phase.progress" && e.message.includes("2 renders ahead"),
    );
    expect(notice).toBeDefined();
    expect(yielded.some((e) => e.type === "render.progress")).toBe(false);
    expect(yielded.some((e) => e.type === "render.done")).toBe(true);
  });

  it("passes an absolute outputPath even when the workspace baseDir is relative", async () => {
    const relBase = relative(process.cwd(), root);
    expect(isAbsolute(relBase)).toBe(false);
    const wm = new WorkspaceManager(relBase);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seedComposition(store, wm);

    let captured: string | undefined;
    class CapturingClient extends StubRenderWorkerClient {
      override async *render(opts: RenderOptions) {
        captured = opts.outputPath;
        yield { type: "done", mp4Path: opts.outputPath } as const;
      }
    }
    const handler = new RenderPhaseHandler({ workerClient: new CapturingClient({ writeOutput: false }) });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(captured).toBeDefined();
    expect(isAbsolute(captured!)).toBe(true);
    expect(captured).toBe(join(resolve(wm.paths("s1").output), basename(captured!)));
  });

  it("propagates ctx.signal abort to the worker client", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seedComposition(store, wm);

    let observedSignal: AbortSignal | undefined;
    class CapturingClient extends StubRenderWorkerClient {
      override async *render(opts: RenderOptions) {
        observedSignal = opts.signal;
        yield { type: "done", mp4Path: opts.outputPath } as const;
      }
    }
    const controller = new AbortController();
    const handler = new RenderPhaseHandler({ workerClient: new CapturingClient({ writeOutput: false }) });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: controller.signal,
    } as any)) { /* drain */ }

    expect(observedSignal).toBe(controller.signal);
  });

  it("emits a subtitles artifact and an .srt file when constraints.subtitles is on", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await wm.init("s1");
    await store.put("s1", "composition", { dir: "composition", entry: "index.html" });
    await writeFile(join(wm.paths("s1").composition, "index.html"), "<html>composed</html>");
    await store.put("s1", "script", {
      totalSec: 8,
      scenes: [{ id: "s1", startSec: 0, durationSec: 8, visual: "v", narration: "Hello there. Welcome aboard." }],
    });
    await store.put("s1", "narration", {
      totalMs: 8000,
      segments: [{ sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 8000 }],
    });
    await store.put("s1", "brief", VALID_BRIEF_WITH_SUBTITLES as never);

    const worker = new StubRenderWorkerClient({ writeOutput: true });
    const handler = new RenderPhaseHandler({ workerClient: worker });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    const subs = await store.get<{ srtPath: string; segments: unknown[] }>("s1", "subtitles");
    expect(subs).not.toBeNull();
    expect(subs!.data.segments.length).toBeGreaterThan(0);
    const srtAbs = join(wm.paths("s1").root, subs!.data.srtPath);
    expect(existsSync(srtAbs)).toBe(true);
    expect(readFileSync(srtAbs, "utf8")).toContain("-->");
  });

  it("does not emit subtitles when constraints.subtitles is absent", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seedComposition(store, wm);
    const handler = new RenderPhaseHandler({ workerClient: new StubRenderWorkerClient({ writeOutput: true }) });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }
    expect(await store.get("s1", "subtitles")).toBeNull();
  });

  it("does not fail the render when subtitle emission throws (subtitles are non-fatal)", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await seedComposition(store, wm);
    await store.put("s1", "script", {
      totalSec: 8,
      scenes: [{ id: "s1", startSec: 0, durationSec: 8, visual: "v", narration: "Hello there. Welcome aboard." }],
    });
    await store.put("s1", "narration", {
      totalMs: 8000,
      segments: [{ sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 8000 }],
    });
    await store.put("s1", "brief", VALID_BRIEF_WITH_SUBTITLES as never);

    // Spy on store.put — allow mp4 through, but reject when writing the subtitles artifact.
    // This simulates a disk-error or Zod rejection during subtitle emission without
    // touching the non-configurable node:fs/promises.writeFile binding.
    const realPut = store.put.bind(store);
    const spy = vi.spyOn(store, "put").mockImplementation(
      (sessionId: string, kind: string, ...args: any[]) => {
        if (kind === "subtitles") return Promise.reject(new Error("disk full"));
        return (realPut as any)(sessionId, kind, ...args);
      },
    );
    try {
      const handler = new RenderPhaseHandler({ workerClient: new StubRenderWorkerClient({ writeOutput: true }) });
      const yielded: ServerEvent[] = [];
      for await (const e of handler.run({
        sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
        signal: new AbortController().signal,
      } as any)) yielded.push(e);

      // mp4 still delivered, render.done still emitted, no subtitles artifact
      expect(yielded.at(-1)).toMatchObject({ type: "render.done" });
      expect(await store.get("s1", "mp4")).not.toBeNull();
      expect(await store.get("s1", "subtitles")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
