import { and, desc, eq, max } from "drizzle-orm";
import type { ArtifactKind, LineageRef } from "@ultracreator/shared";
import { artifact } from "../db/schema/creator.js";
import type { Db } from "../db/client.js";
import type { ArtifactRepository, ArtifactRow } from "./artifact-repository.js";

type Row = typeof artifact.$inferSelect;

function toRow(r: Row): ArtifactRow {
  return {
    kind: r.kind as ArtifactKind,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    derivedFrom: (r.derivedFrom as LineageRef[] | null) ?? null,
    stale: r.stale,
    data: r.data,
  };
}

export class PgArtifactRepository implements ArtifactRepository {
  constructor(private db: Db) {}

  async maxVersion(sessionId: string, kind: ArtifactKind): Promise<number> {
    const rows = await this.db
      .select({ m: max(artifact.version) })
      .from(artifact)
      .where(and(eq(artifact.sessionId, sessionId), eq(artifact.kind, kind)));
    return rows[0]?.m ?? 0;
  }

  async insert(sessionId: string, row: ArtifactRow): Promise<void> {
    await this.db.insert(artifact).values({
      sessionId,
      kind: row.kind,
      version: row.version,
      data: row.data,
      derivedFrom: row.derivedFrom,
      stale: row.stale,
      createdAt: new Date(row.createdAt),
    });
  }

  async getLatest(sessionId: string, kind: ArtifactKind): Promise<ArtifactRow | null> {
    const rows = await this.db
      .select()
      .from(artifact)
      .where(and(eq(artifact.sessionId, sessionId), eq(artifact.kind, kind)))
      .orderBy(desc(artifact.version))
      .limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async getVersion(sessionId: string, kind: ArtifactKind, version: number): Promise<ArtifactRow | null> {
    const rows = await this.db
      .select()
      .from(artifact)
      .where(
        and(eq(artifact.sessionId, sessionId), eq(artifact.kind, kind), eq(artifact.version, version)),
      )
      .limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(sessionId: string): Promise<ArtifactRow[]> {
    const rows = await this.db
      .select()
      .from(artifact)
      .where(eq(artifact.sessionId, sessionId))
      .orderBy(artifact.kind, artifact.version);
    return rows.map(toRow);
  }

  async markStale(sessionId: string, kind: ArtifactKind, version: number): Promise<boolean> {
    const updated = await this.db
      .update(artifact)
      .set({ stale: true })
      .where(
        and(eq(artifact.sessionId, sessionId), eq(artifact.kind, kind), eq(artifact.version, version)),
      )
      .returning({ id: artifact.id });
    return updated.length > 0;
  }
}
