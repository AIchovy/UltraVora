import type { Model } from "@earendil-works/pi-ai";
import type { PhaseId } from "@ultracreator/shared";
import { WorkspaceManager } from "./workspace/workspace-manager.js";
import { EventBus } from "./events/event-bus.js";
import { ArtifactStore } from "./artifacts/artifact-store.js";
import { PhaseRegistry } from "./phases/registry.js";
import { RuleBasedIntentRouter } from "./intent/intent-router.js";
import type { IntentRouter } from "./intent/intent-router.js";
import { LLMIntentRouter } from "./intent/llm-intent-router.js";
import { SessionOrchestrator } from "./orchestrator/session-orchestrator.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { ImageProvider, MusicProvider, TTSProvider } from "./providers/types.js";
import { GeminiImageProvider } from "./providers/gemini-image.js";
import { GeminiMusicProvider } from "./providers/gemini-music.js";
import type { PhaseHandler } from "./phases/types.js";
import { PiAgentFactory } from "./phases/pi-agent-factory.js";
import { PiResearchPhaseHandler } from "./phases/pi-research-handler.js";
import { PiDesignPhaseHandler } from "./phases/pi-design-handler.js";
import { PiScriptPhaseHandler } from "./phases/pi-script-handler.js";
import { VoiceoverPhaseHandler } from "./phases/voiceover-handler.js";
import { PiComposePhaseHandler } from "./phases/pi-compose-handler.js";
import { RenderPhaseHandler } from "./phases/render-handler.js";
import { findRenderedFrameIssues } from "./render/blank-frame-check.js";
import { GeminiVisualCritic } from "./render/visual-critic.js";
import type { RenderWorkerClient } from "./render/render-worker-client.js";
import { resolveRenderWorkerClient } from "./render/resolve-render-worker-client.js";
import type { WebFetchToolOptions, DownloadAssetToolOptions } from "./tools/research-tools.js";
import type { MessageStore } from "./messages/message-store.js";
import type { SessionRepository } from "./sessions/session-repository.js";
import type { CreditRepository } from "./credits/credit-repository.js";
import type { ArtifactRepository } from "./artifacts/artifact-repository.js";
import type { StorageGateway } from "./storage/storage-gateway.js";
import { SessionMediaArchive } from "./storage/session-media-archive.js";

export interface ComposeOrchestratorOptions {
  /** Base directory for all session workspaces (e.g. ./workspaces). */
  baseDir: string;
  /** Pi-ai Model used by every Pi-driven handler (research/design/script). */
  model: Model<any>;
  /** Fetcher injected into the research phase's web_fetch tool. */
  fetch: WebFetchToolOptions["fetch"];
  /** Binary fetcher injected into the research phase's download_asset tool. */
  fetchBinary: DownloadAssetToolOptions["fetchBinary"];
  /** TTS provider; registered as the default "tts" entry in the provider registry. */
  tts: TTSProvider;
  /**
   * Optional image provider. When omitted, one is constructed from `geminiApiKey`
   * (if set). When neither is available, the design/compose agents run without a
   * generate_image tool. Tests inject a fake to avoid real API calls.
   */
  imageProvider?: ImageProvider;
  /**
   * Optional music provider. When omitted, one is constructed from `geminiApiKey`
   * (if set). Used by the compose agent's generate_music tool when BGM is enabled.
   */
  musicProvider?: MusicProvider;
  /**
   * Optional API key for the Anthropic provider. When set, forwarded to
   * every Pi agent via `PiAgentFactory.getApiKey` so the pi-ai SDK can
   * authenticate requests without reading from the environment at call time.
   */
  anthropicApiKey?: string;
  /**
   * Optional API key for the OpenRouter provider. When set, forwarded to
   * every Pi agent so the pi-ai SDK can authenticate OpenRouter requests.
   */
  openrouterApiKey?: string;
  /**
   * Optional API key for the Gemini provider. The production bootstrap passes
   * this through from the already-required GEMINI_API_KEY env var.
   */
  geminiApiKey?: string;
  /** Optional model override for rendered-frame creative direction review. */
  visualCriticModel?: string;
  /**
   * Optional dedicated model for intent classification (e.g. a fast/cheap
   * model). Defaults to `model`.
   */
  intentModel?: Model<any>;
  /** Optional intent router override. Wins over LLM/rule selection (tests). */
  intentRouterOverride?: IntentRouter;
  /**
   * Optional render worker client. Default: `ForkedRenderWorkerClient` which
   * invokes `npx hyperframes render` in a forked child process. Tests inject
   * `StubRenderWorkerClient`.
   */
  renderWorkerClient?: RenderWorkerClient;
  /**
   * Max renders forked at once, process-wide (a headless-Chrome render forks
   * per session; on a 2-vCPU host, several finishing at once slow each other
   * down and risk the render timeouts or OOM). Omitted = unlimited, matching
   * prior behavior. Ignored when `renderWorkerClient` is set explicitly.
   */
  renderConcurrency?: number;
  /** Forwarded to RenderPhaseHandler. */
  renderQuality?: "draft" | "standard" | "high";
  /** Forwarded to RenderPhaseHandler. */
  renderFps?: 24 | 30 | 60;
  /** Highest-priority render override; if set, wins over renderWorkerClient. */
  renderHandlerOverride?: PhaseHandler;
  /** Optional compose handler override (e.g. with a stubbed quality runner in tests). */
  composeHandlerOverride?: PhaseHandler;
  /** Optional per-phase handler overrides for any phase. Wins over default Pi handlers. */
  handlerOverrides?: Partial<Record<PhaseId, PhaseHandler>>;
  /** Session persistence repository. */
  sessions: SessionRepository;
  /** Artifact persistence repository. */
  artifactRepo: ArtifactRepository;
  /** Durable message queue repository. */
  messageStore: MessageStore;
  /**
   * Optional object store for heavy-media archiving (spec §5). When omitted
   * (dev/test default), nothing is archived and all files stay on local disk.
   */
  storageGateway?: StorageGateway;
  /** Optional credit gating; when set, phases are charged before they run. */
  credits?: Pick<CreditRepository, "debit">;
}

export interface ComposedOrchestrator {
  orchestrator: SessionOrchestrator;
  workspaces: WorkspaceManager;
  events: EventBus;
  artifacts: ArtifactStore;
  phases: PhaseRegistry;
  providers: ProviderRegistry;
  media?: SessionMediaArchive;
}

/**
 * Pick the intent router: explicit override (tests) > LLM router when the
 * intent model's provider has an API key > rule router alone. The key check
 * keeps keyless environments (existing integration tests, offline dev) on the
 * rule router with zero LLM-timeout waits.
 */
export function selectIntentRouter(
  opts: Pick<
    ComposeOrchestratorOptions,
    "model" | "intentModel" | "intentRouterOverride" | "anthropicApiKey" | "openrouterApiKey" | "geminiApiKey"
  >,
): IntentRouter {
  if (opts.intentRouterOverride) return opts.intentRouterOverride;
  const getApiKey = (provider: string): string | undefined => {
    if (provider === "anthropic") return opts.anthropicApiKey;
    if (provider === "openrouter") return opts.openrouterApiKey;
    if (provider === "google") return opts.geminiApiKey;
    return undefined;
  };
  const model = opts.intentModel ?? opts.model;
  const fallback = new RuleBasedIntentRouter();
  if (!getApiKey(model.provider)) return fallback;
  return new LLMIntentRouter({ model, getApiKey, fallback });
}

/**
 * Wire the full backend graph for a single Node process. Returns the
 * orchestrator and its dependencies for callers (Fastify route handlers in
 * Plan 5, and tests).
 */
export function composeOrchestrator(opts: ComposeOrchestratorOptions): ComposedOrchestrator {
  const workspaces = new WorkspaceManager(opts.baseDir);
  const events = new EventBus();
  const artifacts = new ArtifactStore(opts.artifactRepo, events);
  const phases = new PhaseRegistry();
  const intentRouter = selectIntentRouter(opts);

  const providers = new ProviderRegistry();
  providers.register("tts", opts.tts);

  // Image provider: explicit override wins, else derive from the Gemini key.
  const imageProvider =
    opts.imageProvider ??
    (opts.geminiApiKey ? new GeminiImageProvider({ apiKey: opts.geminiApiKey }) : undefined);
  if (imageProvider) providers.register("image", imageProvider);

  // Music provider: explicit override wins, else derive from the Gemini key.
  const musicProvider =
    opts.musicProvider ??
    (opts.geminiApiKey ? new GeminiMusicProvider({ apiKey: opts.geminiApiKey }) : undefined);
  if (musicProvider) providers.register("music", musicProvider);

  const agentFactory = new PiAgentFactory(
    opts.anthropicApiKey || opts.openrouterApiKey || opts.geminiApiKey
      ? {
        getApiKey: (provider) => {
          if (provider === "anthropic") return opts.anthropicApiKey;
          if (provider === "openrouter") return opts.openrouterApiKey;
          if (provider === "google") return opts.geminiApiKey;
          return undefined;
        },
      }
      : {},
  );

  const renderHandler =
    opts.renderHandlerOverride
    ?? new RenderPhaseHandler({
      workerClient: resolveRenderWorkerClient(opts),
      // Final delivery defaults to the CLI's high-quality tier; the option
      // (RENDER_QUALITY env in prod) is the rollback lever if render time
      // becomes a problem.
      quality: opts.renderQuality ?? "high",
      fps: opts.renderFps,
    });

  const handlers = new Map<PhaseId, PhaseHandler>([
    ["research", new PiResearchPhaseHandler({
      agentFactory,
      model: opts.model,
      fetch: opts.fetch,
      fetchBinary: opts.fetchBinary,
    })],
    ["design", new PiDesignPhaseHandler({ agentFactory, model: opts.model, imageProvider })],
    ["script", new PiScriptPhaseHandler({ agentFactory, model: opts.model })],
    ["voiceover", new VoiceoverPhaseHandler({ providers })],
    ["compose",
      opts.composeHandlerOverride
      ?? new PiComposePhaseHandler({
        agentFactory,
        model: opts.model,
        imageProvider,
        musicProvider,
        blankFrameCheck: (dir, signal) => findRenderedFrameIssues(dir, { signal }),
        ...(opts.geminiApiKey
          ? {
              visualCritic: new GeminiVisualCritic({
                apiKey: opts.geminiApiKey,
                model: opts.visualCriticModel,
              }),
            }
          : {}),
      })],
    ["render", renderHandler],
  ]);

  for (const [phase, handler] of Object.entries(opts.handlerOverrides ?? {}) as [PhaseId, PhaseHandler][]) {
    handlers.set(phase, handler);
  }

  const media = opts.storageGateway
    ? new SessionMediaArchive({
        storage: opts.storageGateway,
        workspaces,
        sessions: opts.sessions,
      })
    : undefined;
  if (media) {
    // Background archive on every completed render (spec §5). archiveSession
    // already swallows per-file failures; the catch covers owner-lookup faults.
    events.subscribeAll((sessionId, event) => {
      if (event.type === "render.done") {
        void media.archiveSession(sessionId).catch((err) =>
          console.warn(`[media-archive] ${sessionId}: archive failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    });
  }

  const orchestrator = new SessionOrchestrator({
    workspaces,
    events,
    artifacts,
    phases,
    intentRouter,
    handlers,
    sessions: opts.sessions,
    messages: opts.messageStore,
    ...(media ? { media } : {}),
    ...(opts.credits ? { credits: opts.credits } : {}),
  });

  return { orchestrator, workspaces, events, artifacts, phases, providers, ...(media ? { media } : {}) };
}
