import { describe, it, expect, beforeEach } from "vitest";
import type { ServerEvent } from "@ultracreator/shared";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";

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

let bus: EventBus;
let store: ArtifactStore;

beforeEach(() => {
  bus = new EventBus();
  store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
});

describe("ArtifactStore", () => {
  it("put validates data and returns a v1 envelope", async () => {
    const env = await store.put("s1", "brief", briefData);
    expect(env.version).toBe(1);
    expect(env.kind).toBe("brief");
    expect((env.data as typeof briefData).product.name).toBe("Acme");
    const got = await store.get("s1", "brief");
    expect((got!.data as typeof briefData).product.name).toBe("Acme");
  });

  it("put rejects data that fails the kind schema", async () => {
    await expect(store.put("s1", "brief", { product: {} })).rejects.toThrow();
  });

  it("put assigns incrementing versions per kind", async () => {
    expect((await store.put("s1", "brief", briefData)).version).toBe(1);
    expect((await store.put("s1", "brief", briefData)).version).toBe(2);
  });

  it("get returns the latest version by default", async () => {
    await store.put("s1", "brief", briefData);
    await store.put("s1", "brief", { ...briefData, audience: "marketers" });
    const latest = await store.get("s1", "brief");
    expect(latest!.version).toBe(2);
    expect((latest!.data as typeof briefData).audience).toBe("marketers");
  });

  it("get returns a specific version when asked", async () => {
    await store.put("s1", "brief", briefData);
    await store.put("s1", "brief", { ...briefData, audience: "marketers" });
    expect(((await store.get("s1", "brief", 1))!.data as typeof briefData).audience).toBe("devs");
  });

  it("records lineage via derivedFrom", async () => {
    await store.put("s1", "brief", briefData);
    const design = await store.put("s1", "design", designData, {
      derivedFrom: [{ kind: "brief", version: 1 }],
    });
    expect(design.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "design")!.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
  });

  it("emits artifact.created on put", async () => {
    const events: ServerEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));
    await store.put("s1", "brief", briefData);
    expect(events).toContainEqual({ type: "artifact.created", kind: "brief", version: 1 });
  });

  it("markStale flips the flag and emits artifact.stale, leaving the stored data immutable", async () => {
    await store.put("s1", "brief", briefData);
    const events: ServerEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));
    await store.markStale("s1", "brief", 1);
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")!.stale).toBe(true);
    expect(events).toContainEqual({ type: "artifact.stale", kind: "brief", version: 1 });
    const env = await store.get("s1", "brief", 1);
    expect((env!.data as typeof briefData).product.name).toBe("Acme");
  });

  it("list returns descriptors (no path field) for all written artifacts", async () => {
    await store.put("s1", "brief", briefData);
    const list = await store.list("s1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "brief", version: 1, stale: false });
    expect(list[0]).not.toHaveProperty("path");
  });

  it("get returns null for a kind that was never written", async () => {
    expect(await store.get("s1", "brief")).toBeNull();
  });

  it("markStale throws when the kind/version does not exist", async () => {
    await store.put("s1", "brief", briefData);
    await expect(store.markStale("s1", "brief", 2)).rejects.toThrow(/to mark stale/i);
  });
});
