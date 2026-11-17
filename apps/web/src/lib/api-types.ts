// apps/web/src/lib/api-types.ts
import type {
  ArtifactDescriptor,
  ArtifactEnvelope,
  ArtifactKind,
  Brief,
  Design,
  PhaseId,
  PlanTier,
  Script,
  ServerEvent,
  Mp4Data,
  MusicData,
  NarrationData,
  CompositionData,
  SubtitlesData,
  SessionSummary,
  PublicVideoSummary,
  PublicVideoSort,
} from "@ultracreator/shared";

// Mirror of apps/server/src/orchestrator/state.ts:SessionState.
// Kept here as a type-only mirror because the server source isn't a workspace dep.
export type SessionState =
  | { kind: "idle" }
  | { kind: "running"; phase: PhaseId }
  | { kind: "awaiting-gate"; phase: PhaseId }
  | { kind: "awaiting-credits"; phase: PhaseId; refinement?: string }
  | { kind: "error"; phase: PhaseId; error: string }
  | { kind: "done"; lastPhase: PhaseId };

/** GET /api/credits response. */
export interface CreditsResponse {
  balance: number;
  /** Balance split by source. Subscription resets monthly; bonus + purchased persist. */
  breakdown: { subscription: number; bonus: number; purchased: number };
  subscription: {
    tier: PlanTier;
    status: "active" | "canceled" | "past_due";
    interval: "monthly" | "yearly";
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  /** Whether the account's one free public generation is still unused. */
  freePublicAvailable: boolean;
}

/** POST /api/billing/checkout response: a Creem redirect URL, or (dev stub) the new balance. */
export interface CheckoutResponse {
  url: string | null;
  balance?: number;
}

export interface GetSessionResponse {
  state: SessionState;
  artifacts: ArtifactDescriptor[];
  title: string | null;
  autoApprove: boolean;
}

export interface CreateSessionResponse {
  sessionId: string;
}

export interface UploadResponse {
  files: { name: string; path: string }[];
}

/** Wire envelope of a single SSE frame: `data: <SequencedEvent>`. */
export interface SequencedEvent {
  seq: number;
  at: string;
  event: ServerEvent;
}

export type ArtifactDataByKind = {
  brief: Brief;
  design: Design;
  script: Script;
  narration: NarrationData;
  composition: CompositionData;
  music: MusicData;
  subtitles: SubtitlesData;
  mp4: Mp4Data;
};

/** Typed envelope returned by `GET /artifacts/:kind`. */
export type TypedArtifactEnvelope<K extends ArtifactKind> = ArtifactEnvelope<ArtifactDataByKind[K]>;

export type { ArtifactDescriptor, ArtifactKind, PhaseId, ServerEvent, SessionSummary, PublicVideoSummary, PublicVideoSort };
