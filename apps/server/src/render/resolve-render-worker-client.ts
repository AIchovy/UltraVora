import { ForkedRenderWorkerClient, type RenderWorkerClient } from "./render-worker-client.js";
import { RenderConcurrencyLimiter } from "./render-concurrency-limiter.js";
import { LimitedRenderWorkerClient } from "./limited-render-worker-client.js";

export interface ResolveRenderWorkerClientOptions {
  /** Explicit client (e.g. a test stub). Wins over everything else. */
  renderWorkerClient?: RenderWorkerClient;
  /**
   * Max renders forked at once, process-wide. Omitted = unlimited (current
   * behavior — every session's render forks independently). Ignored when
   * `renderWorkerClient` is set explicitly.
   */
  renderConcurrency?: number;
}

/**
 * Pure wiring: resolves the RenderWorkerClient compose-orchestrator.ts hands
 * to RenderPhaseHandler. Extracted so the decision (bare fork client vs.
 * concurrency-limited) is unit-testable without forking real processes.
 */
export function resolveRenderWorkerClient(opts: ResolveRenderWorkerClientOptions): RenderWorkerClient {
  if (opts.renderWorkerClient) return opts.renderWorkerClient;
  const client = new ForkedRenderWorkerClient();
  if (opts.renderConcurrency === undefined) return client;
  return new LimitedRenderWorkerClient(client, new RenderConcurrencyLimiter(opts.renderConcurrency));
}
