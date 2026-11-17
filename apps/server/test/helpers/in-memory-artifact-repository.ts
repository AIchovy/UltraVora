import type { ArtifactKind } from "@ultracreator/shared";
import type { ArtifactRepository, ArtifactRow } from "../../src/artifacts/artifact-repository.js";

/** In-memory ArtifactRepository for unit tests. Behaves identically to the PG impl. */
export class InMemoryArtifactRepository implements ArtifactRepository {
  private rows = new Map<string, ArtifactRow[]>();

  private rowsForSession(sessionId: string): ArtifactRow[] {
    return this.rows.get(sessionId) ?? [];
  }

  async maxVersion(sessionId: string, kind: ArtifactKind): Promise<number> {
    const versions = this.rowsForSession(sessionId).filter((r) => r.kind === kind).map((r) => r.version);
    return versions.length > 0 ? Math.max(...versions) : 0;
  }

  async insert(sessionId: string, row: ArtifactRow): Promise<void> {
    const list = this.rowsForSession(sessionId);
    list.push({ ...row });
    this.rows.set(sessionId, list);
  }

  async getLatest(sessionId: string, kind: ArtifactKind): Promise<ArtifactRow | null> {
    const candidates = this.rowsForSession(sessionId).filter((r) => r.kind === kind);
    if (candidates.length === 0) return null;
    const latest = candidates.reduce((a, b) => (b.version > a.version ? b : a));
    return { ...latest };
  }

  async getVersion(sessionId: string, kind: ArtifactKind, version: number): Promise<ArtifactRow | null> {
    const found = this.rowsForSession(sessionId).find((r) => r.kind === kind && r.version === version);
    return found ? { ...found } : null;
  }

  async list(sessionId: string): Promise<ArtifactRow[]> {
    return this.rowsForSession(sessionId).map((r) => ({ ...r }));
  }

  async markStale(sessionId: string, kind: ArtifactKind, version: number): Promise<boolean> {
    const found = this.rowsForSession(sessionId).find((r) => r.kind === kind && r.version === version);
    if (!found) return false;
    found.stale = true;
    return true;
  }
}
