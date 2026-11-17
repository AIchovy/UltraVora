import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { StubTTSProvider } from "../src/providers/stub-tts.js";
import { VoiceoverPhaseHandler } from "../src/phases/voiceover-handler.js";
import type { TTSInput, TTSProvider, TTSResult } from "../src/providers/types.js";

/** Fails the first `failures` synthesize calls, then delegates to a stub. */
class FlakyTTSProvider implements TTSProvider {
  readonly id = "flaky";
  calls = 0;
  private inner = new StubTTSProvider();
  constructor(
    private failures: number,
    private makeError: () => Error = () =>
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("Connect Timeout Error"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      }),
  ) {}
  async synthesize(input: TTSInput): Promise<TTSResult> {
    this.calls++;
    if (this.calls <= this.failures) throw this.makeError();
    return this.inner.synthesize(input);
  }
}

/** Records the `voice`/`styleInstruction` passed to each synthesize call; writes valid silence WAVs. */
class CapturingTTSProvider implements TTSProvider {
  readonly id = "capturing";
  voices: (string | undefined)[] = [];
  styles: (string | undefined)[] = [];
  private inner = new StubTTSProvider();
  async synthesize(input: TTSInput): Promise<TTSResult> {
    this.voices.push(input.voice);
    this.styles.push(input.styleInstruction);
    return this.inner.synthesize(input);
  }
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-vo-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
};
const designData = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades",
  keyVisuals: [],
  sampleFrames: [],
};
const scriptWithNarration = {
  totalSec: 30,
  scenes: [
    { id: "s1", startSec: 0, durationSec: 6, visual: "logo", narration: "Meet Acme." },
    { id: "s2", startSec: 6, durationSec: 24, visual: "demo", narration: "It just works." },
  ],
};
const scriptWithoutNarration = {
  totalSec: 30,
  scenes: [
    { id: "s1", startSec: 0, durationSec: 30, visual: "shot" },
  ],
};

async function seed(store: ArtifactStore, script: object) {
  await store.put("s1", "brief", briefData);
  await store.put("s1", "design", designData);
  await store.put("s1", "script", script, { derivedFrom: [{ kind: "design", version: 1 }] });
}

describe("VoiceoverPhaseHandler", () => {
  it("synthesizes each narrated scene and writes a per-scene timeline artifact", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await seed(store, scriptWithNarration);

    const providers = new ProviderRegistry();
    providers.register("tts", new StubTTSProvider()); // 200ms/word silence WAVs

    const handler = new VoiceoverPhaseHandler({ providers });

    const events: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1", workspaces, artifacts: store, events: bus,
      signal: new AbortController().signal,
    })) events.push(e);

    const env = await store.get("s1", "narration");
    const data = env!.data as {
      totalMs: number;
      segments: { sceneId: string; audioFile?: string; startMs: number; durationMs: number }[];
    };
    // Both scenes are narrated → both have audioFile, in order, non-overlapping.
    expect(data.segments.map((s) => s.sceneId)).toEqual(["s1", "s2"]);
    expect(data.segments[0]!.audioFile).toBe("narration-s1.wav");
    expect(data.segments[1]!.audioFile).toBe("narration-s2.wav");
    expect(data.segments[0]!.startMs).toBe(0);
    expect(data.segments[1]!.startMs).toBe(data.segments[0]!.durationMs);
    expect(data.totalMs).toBe(data.segments[1]!.startMs + data.segments[1]!.durationMs);

    // Per-scene wav files were written into the composition dir.
    const comp = workspaces.paths("s1").composition;
    expect(existsSync(join(comp, "narration-s1.wav"))).toBe(true);
    expect(existsSync(join(comp, "narration-s2.wav"))).toBe(true);

    expect(events.some((e) => e.type === "phase.progress" && /synth/i.test(e.message))).toBe(true);
  });

  it("passes brief.constraints.voice to every synthesize call", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", {
      ...briefData,
      constraints: { ...briefData.constraints, voice: "Puck" },
    });
    await store.put("s1", "design", designData);
    await store.put("s1", "script", scriptWithNarration, {
      derivedFrom: [{ kind: "design", version: 1 }],
    });

    const capturing = new CapturingTTSProvider();
    const providers = new ProviderRegistry();
    providers.register("tts", capturing);
    const handler = new VoiceoverPhaseHandler({ providers });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces, artifacts: store, events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    expect(capturing.voices).toEqual(["Puck", "Puck"]); // both narrated scenes
  });

  it("derives a delivery-style instruction from the design's mood and motion style", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", briefData);
    await store.put("s1", "design", designData); // mood: "energetic"
    await store.put("s1", "script", scriptWithNarration, {
      derivedFrom: [{ kind: "design", version: 1 }],
    });

    const capturing = new CapturingTTSProvider();
    const providers = new ProviderRegistry();
    providers.register("tts", capturing);
    const handler = new VoiceoverPhaseHandler({ providers });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces, artifacts: store, events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    expect(capturing.styles).toHaveLength(2);
    expect(capturing.styles[0]).toMatch(/energetic/);
  });

  it("passes no style instruction when there is no design artifact", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", briefData);
    await store.put("s1", "script", scriptWithNarration);

    const capturing = new CapturingTTSProvider();
    const providers = new ProviderRegistry();
    providers.register("tts", capturing);
    const handler = new VoiceoverPhaseHandler({ providers });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces, artifacts: store, events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    expect(capturing.styles).toEqual([undefined, undefined]);
  });

  it("passes undefined voice when the brief omits it (provider falls back to default)", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await seed(store, scriptWithNarration); // briefData has no voice

    const capturing = new CapturingTTSProvider();
    const providers = new ProviderRegistry();
    providers.register("tts", capturing);
    const handler = new VoiceoverPhaseHandler({ providers });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces, artifacts: store, events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    expect(capturing.voices).toEqual([undefined, undefined]);
  });

  it("keeps planned duration for silent scenes interleaved with narrated ones", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    const mixed = {
      totalSec: 18,
      scenes: [
        { id: "s1", startSec: 0, durationSec: 6, visual: "logo", narration: "Meet Acme." },
        { id: "s2", startSec: 6, durationSec: 6, visual: "quiet shot" },
        { id: "s3", startSec: 12, durationSec: 6, visual: "demo", narration: "It works." },
      ],
    };
    await seed(store, mixed);

    const providers = new ProviderRegistry();
    providers.register("tts", new StubTTSProvider());
    const handler = new VoiceoverPhaseHandler({ providers });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces, artifacts: store, events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    const env = await store.get("s1", "narration");
    const data = env!.data as { segments: { sceneId: string; audioFile?: string; durationMs: number }[] };
    expect(data.segments.map((s) => s.audioFile)).toEqual([
      "narration-s1.wav", undefined, "narration-s3.wav",
    ]);
    expect(data.segments[1]!.durationMs).toBe(6000); // planned 6s kept for the silent scene
    // Only narrated scenes produced wav files.
    const comp = workspaces.paths("s1").composition;
    expect(existsSync(join(comp, "narration-s2.wav"))).toBe(false);
  });

  it("is a no-op (no artifact, no error) when the script has no narration", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await seed(store, scriptWithoutNarration);

    const providers = new ProviderRegistry();
    providers.register("tts", new StubTTSProvider());

    const handler = new VoiceoverPhaseHandler({ providers });

    for await (const _ of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "narration")).toBeUndefined();
  });

  it("retries a transient synthesize failure and completes the phase", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await seed(store, scriptWithNarration);

    const flaky = new FlakyTTSProvider(1); // first call fails, rest succeed
    const providers = new ProviderRegistry();
    providers.register("tts", flaky);
    const handler = new VoiceoverPhaseHandler({ providers, retry: { baseDelayMs: 1 } });

    const events: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1", workspaces, artifacts: store, events: bus,
      signal: new AbortController().signal,
    })) events.push(e);

    // Scene s1: 1 failure + 1 success; scene s2: 1 success.
    expect(flaky.calls).toBe(3);
    expect(await store.get("s1", "narration")).not.toBeNull();
    const retryNotice = events.find(
      (e) => e.type === "phase.progress" && /retry/i.test(e.message),
    );
    expect(retryNotice).toBeDefined();
    // The retry notice surfaces the underlying cause, not just "fetch failed".
    expect((retryNotice as { message: string }).message).toMatch(/UND_ERR_CONNECT_TIMEOUT/);
  });

  it("gives up after max attempts and rethrows the transient error", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await seed(store, scriptWithNarration);

    const flaky = new FlakyTTSProvider(Number.POSITIVE_INFINITY);
    const providers = new ProviderRegistry();
    providers.register("tts", flaky);
    const handler = new VoiceoverPhaseHandler({
      providers,
      retry: { attempts: 3, baseDelayMs: 1 },
    });

    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1", workspaces, artifacts: store, events: bus,
        signal: new AbortController().signal,
      })) { /* drain */ }
    }).rejects.toThrow(/fetch failed/);
    expect(flaky.calls).toBe(3); // only the first scene, attempted exactly 3 times
  });

  it("does not retry non-transient provider errors", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await seed(store, scriptWithNarration);

    const flaky = new FlakyTTSProvider(
      Number.POSITIVE_INFINITY,
      () => new Error("Gemini TTS returned no audio inline data"),
    );
    const providers = new ProviderRegistry();
    providers.register("tts", flaky);
    const handler = new VoiceoverPhaseHandler({ providers, retry: { baseDelayMs: 1 } });

    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1", workspaces, artifacts: store, events: bus,
        signal: new AbortController().signal,
      })) { /* drain */ }
    }).rejects.toThrow(/no audio inline data/);
    expect(flaky.calls).toBe(1);
  });

  it("throws when no TTS provider is registered", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await seed(store, scriptWithNarration);

    const providers = new ProviderRegistry();
    const handler = new VoiceoverPhaseHandler({ providers });

    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1",
        workspaces,
        artifacts: store,
        events: bus,
        signal: new AbortController().signal,
      })) { /* drain */ }
    }).rejects.toThrow(/no provider/i);
  });
});
