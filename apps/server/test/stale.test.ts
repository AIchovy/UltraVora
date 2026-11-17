import { describe, it, expect } from "vitest";
import type { ServerEvent } from "@ultracreator/shared";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { PhaseRegistry } from "../src/phases/registry.js";
import { markStaleDownstream } from "../src/orchestrator/stale.js";

const brief = {
  product: { name: "x", tagline: "y", description: "z", category: "c" },
  audience: "a",
  keyMessages: ["m"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
};
const design = {
  mood: "x",
  palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades",
  keyVisuals: [],
  sampleFrames: [],
};
const script = {
  totalSec: 30,
  scenes: [{ id: "s1", startSec: 0, durationSec: 5, visual: "v" }],
};

async function seedFullChain(store: ArtifactStore) {
  await store.put("s1", "brief", brief);
  await store.put("s1", "design", design, { derivedFrom: [{ kind: "brief", version: 1 }] });
  await store.put("s1", "script", script, { derivedFrom: [{ kind: "design", version: 1 }] });
  await store.put("s1", "narration", {
    totalMs: 10000,
    segments: [{ sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 10000 }],
  });
  await store.put("s1", "composition", { dir: "composition", entry: "index.html" });
  await store.put("s1", "mp4", { path: "output/out.mp4" });
}

describe("markStaleDownstream", () => {
  it("marks design/script/narration/composition/mp4 stale when revising back to research", async () => {
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    const registry = new PhaseRegistry();
    await seedFullChain(store);

    const events: ServerEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));

    await markStaleDownstream(store, registry, "s1", "research");

    const list = await store.list("s1");
    const byKind = Object.fromEntries(list.map((d) => [d.kind, d]));
    expect(byKind.brief!.stale).toBe(false);
    expect(byKind.design!.stale).toBe(true);
    expect(byKind.script!.stale).toBe(true);
    expect(byKind.narration!.stale).toBe(true);
    expect(byKind.composition!.stale).toBe(true);
    expect(byKind.mp4!.stale).toBe(true);

    for (const kind of ["design", "script", "narration", "composition", "mp4"] as const) {
      expect(events).toContainEqual({ type: "artifact.stale", kind, version: 1 });
    }
  });

  it("only marks downstream of design (script and below)", async () => {
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    const registry = new PhaseRegistry();
    await seedFullChain(store);

    await markStaleDownstream(store, registry, "s1", "design");
    const list = await store.list("s1");
    const byKind = Object.fromEntries(list.map((d) => [d.kind, d]));
    expect(byKind.brief!.stale).toBe(false);
    expect(byKind.design!.stale).toBe(false);
    expect(byKind.script!.stale).toBe(true);
    expect(byKind.narration!.stale).toBe(true);
    expect(byKind.composition!.stale).toBe(true);
    expect(byKind.mp4!.stale).toBe(true);
  });

  it("is a no-op when revising back to render (no downstream phases)", async () => {
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    const registry = new PhaseRegistry();
    await seedFullChain(store);

    const events: ServerEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));

    await markStaleDownstream(store, registry, "s1", "render");
    expect(events.filter((e) => e.type === "artifact.stale")).toEqual([]);
  });

  it("skips a phase whose output isn't in the repository yet", async () => {
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    const registry = new PhaseRegistry();
    await store.put("s1", "brief", brief);
    await store.put("s1", "design", design);

    await markStaleDownstream(store, registry, "s1", "research");
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "design")!.stale).toBe(true);
    expect(list.find((d) => d.kind === "script")).toBeUndefined();
  });

  it("marks only the latest non-stale version when multiple versions exist", async () => {
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    const registry = new PhaseRegistry();
    await store.put("s1", "brief", brief);
    await store.put("s1", "design", design);
    await store.put("s1", "design", { ...design, mood: "premium" });
    await store.markStale("s1", "design", 1);

    await markStaleDownstream(store, registry, "s1", "research");
    const list = await store.list("s1");
    const designs = list.filter((d) => d.kind === "design");
    expect(designs.find((d) => d.version === 1)!.stale).toBe(true);
    expect(designs.find((d) => d.version === 2)!.stale).toBe(true);
  });
});
