import type {
  ArtifactKind,
  LineageRef,
  PhaseId,
  ServerEvent,
  UserMessage,
} from "@ultracreator/shared";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { EventBus } from "../events/event-bus.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

export interface PhaseContext {
  sessionId: string;
  workspaces: WorkspaceManager;
  artifacts: ArtifactStore;
  events: EventBus;
  /** Present during the first phase of a new project (research). */
  initialMessage?: UserMessage;
  /** Free-form refinement text from the user (refine / revise-back). */
  refinement?: string;
  /** Aborted by the orchestrator when the user issues `abort`. */
  signal: AbortSignal;
}

export interface PhaseHandler {
  readonly phase: PhaseId;
  /** Yields ServerEvents (phase.progress, etc.). Handlers MUST NOT yield artifact.created — ArtifactStore.put emits that itself. */
  run(ctx: PhaseContext): AsyncIterable<ServerEvent>;
}

/** Convenience shape for FakePhaseHandler / future test fixtures. */
export interface ArtifactToWrite {
  kind: ArtifactKind;
  data: unknown;
  derivedFrom?: LineageRef[];
}
