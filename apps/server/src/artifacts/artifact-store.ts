import {
  ARTIFACT_DATA_SCHEMAS,
  type ArtifactDescriptor,
  type ArtifactEnvelope,
  type ArtifactKind,
  type LineageRef,
} from "@ultracreator/shared";
import type { EventBus } from "../events/event-bus.js";
import type { ArtifactRepository } from "./artifact-repository.js";

export interface PutOptions {
  derivedFrom?: LineageRef[];
}

/**
 * The only writer of artifact descriptors for a session. Validates payloads,
 * assigns per-kind versions, persists via an ArtifactRepository, and emits
 * EventBus notifications. Media files (mp4/audio/composition dir) stay on disk
 * and are written by the phase handlers, not here; `data` only holds the
 * descriptor with workspace-relative paths inside it.
 *
 * Concurrency contract: `put`/`markStale` read-then-write version state, so
 * writes to a single session MUST be serialized by the caller (the orchestrator
 * holds one logical lock per session — see spec §8). The repository's
 * unique(session_id, kind, version) constraint is the backstop.
 */
export class ArtifactStore {
  constructor(
    private repo: ArtifactRepository,
    private events: EventBus,
  ) {}

  async put<T>(
    sessionId: string,
    kind: ArtifactKind,
    data: T,
    opts: PutOptions = {},
  ): Promise<ArtifactEnvelope<T>> {
    const schema = ARTIFACT_DATA_SCHEMAS[kind];
    const validated = schema.parse(data) as T;

    const version = (await this.repo.maxVersion(sessionId, kind)) + 1;
    const createdAt = new Date().toISOString();
    const derivedFrom = opts.derivedFrom ?? null;

    await this.repo.insert(sessionId, {
      kind,
      version,
      createdAt,
      derivedFrom,
      stale: false,
      data: validated,
    });

    this.events.emit(sessionId, { type: "artifact.created", kind, version });
    return { kind, version, createdAt, derivedFrom, data: validated };
  }

  async get<T = unknown>(
    sessionId: string,
    kind: ArtifactKind,
    version?: number,
  ): Promise<ArtifactEnvelope<T> | null> {
    const row =
      version !== undefined
        ? await this.repo.getVersion(sessionId, kind, version)
        : await this.repo.getLatest(sessionId, kind);
    if (!row) return null;
    return {
      kind: row.kind,
      version: row.version,
      createdAt: row.createdAt,
      derivedFrom: row.derivedFrom,
      data: row.data as T,
    };
  }

  async list(sessionId: string): Promise<ArtifactDescriptor[]> {
    const rows = await this.repo.list(sessionId);
    return rows.map((r) => ({
      kind: r.kind,
      version: r.version,
      createdAt: r.createdAt,
      derivedFrom: r.derivedFrom,
      stale: r.stale,
    }));
  }

  async markStale(sessionId: string, kind: ArtifactKind, version: number): Promise<void> {
    const ok = await this.repo.markStale(sessionId, kind, version);
    if (!ok) throw new Error(`No ${kind} v${version} to mark stale`);
    this.events.emit(sessionId, { type: "artifact.stale", kind, version });
  }
}
