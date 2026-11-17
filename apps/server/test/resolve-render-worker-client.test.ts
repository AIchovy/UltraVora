// Pure wiring logic for compose-orchestrator.ts, tested in isolation so we
// don't need to fork real `hyperframes render` processes to verify it.
import { describe, it, expect } from "vitest";
import { resolveRenderWorkerClient } from "../src/render/resolve-render-worker-client.js";
import { ForkedRenderWorkerClient } from "../src/render/render-worker-client.js";
import { LimitedRenderWorkerClient } from "../src/render/limited-render-worker-client.js";
import { StubRenderWorkerClient } from "../src/render/stub-render-worker.js";

describe("resolveRenderWorkerClient", () => {
  it("with no options, returns a bare ForkedRenderWorkerClient (unlimited, current behavior)", () => {
    const client = resolveRenderWorkerClient({});
    expect(client).toBeInstanceOf(ForkedRenderWorkerClient);
  });

  it("an explicit renderWorkerClient override always wins, even with renderConcurrency set", () => {
    const stub = new StubRenderWorkerClient({ writeOutput: false });
    const client = resolveRenderWorkerClient({ renderWorkerClient: stub, renderConcurrency: 1 });
    expect(client).toBe(stub);
  });

  it("renderConcurrency set (no override) wraps the default fork client with the limiter", () => {
    const client = resolveRenderWorkerClient({ renderConcurrency: 2 });
    expect(client).toBeInstanceOf(LimitedRenderWorkerClient);
  });

  it("rejects a non-positive renderConcurrency", () => {
    expect(() => resolveRenderWorkerClient({ renderConcurrency: 0 })).toThrow();
  });
});
