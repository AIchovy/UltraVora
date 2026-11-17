import type { ArtifactKind, LineageRef } from "@ultracreator/shared";

/** A persisted artifact row. `data` is the validated artifact payload (jsonb). */
export interface ArtifactRow {
  kind: ArtifactKind;
  version: number;
  createdAt: string;
  derivedFrom: LineageRef[] | null;
  stale: boolean;
  data: unknown;
}

/**
 * Raw persistence for a session's artifacts. Versioning, Zod validation, and
 * EventBus emission live in ArtifactStore; this is dumb CRUD so the PG and
 * in-memory impls stay behaviorally identical. The caller serializes writes per
 * session (orchestrator holds one logical lock), and the PG unique constraint
 * (session_id, kind, version) is the backstop.
 */
export interface ArtifactRepository {
  /** Highest version for (session, kind), or 0 if none. */
  maxVersion(sessionId: string, kind: ArtifactKind): Promise<number>;
  insert(sessionId: string, row: ArtifactRow): Promise<void>;
  getLatest(sessionId: string, kind: ArtifactKind): Promise<ArtifactRow | null>;
  getVersion(sessionId: string, kind: ArtifactKind, version: number): Promise<ArtifactRow | null>;
  /** All artifact rows for the session (any kind/version), for list(). */
  list(sessionId: string): Promise<ArtifactRow[]>;
  /** Flip stale=true. Returns false if no matching row. */
  markStale(sessionId: string, kind: ArtifactKind, version: number): Promise<boolean>;
}
