import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { ArtifactKindSchema } from "@ultracreator/shared";
import type { AppDeps } from "./app.js";
import { requireOwnedSession } from "./route-helpers.js";

export async function registerArtifactsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<{ Params: { sid: string } }>(
    "/api/sessions/:sid/artifacts",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      const list = await deps.artifacts.list(sid);
      reply.send(list);
    },
  );

  app.get<{ Params: { sid: string; kind: string }; Querystring: { version?: string } }>(
    "/api/sessions/:sid/artifacts/:kind",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      const kindParse = ArtifactKindSchema.safeParse(req.params.kind);
      if (!kindParse.success) {
        reply.code(400).send({ error: "invalid artifact kind" });
        return;
      }
      const version = req.query.version !== undefined ? Number(req.query.version) : undefined;
      if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
        reply.code(400).send({ error: "version must be a positive integer" });
        return;
      }
      const env = await deps.artifacts.get(sid, kindParse.data, version);
      if (!env) {
        reply.code(404).send({ error: "artifact not found" });
        return;
      }
      reply.send(env);
    },
  );

  // Promote an older video version back to "current" (the user adjusted a few
  // times and prefers an earlier cut). Free: no LLM, no render — the old mp4
  // file still exists (every render writes a fresh UUID name) and is simply
  // re-published as a new latest version. When the composition snapshot that
  // produced it is still on disk (index.v<N>.html, written since c823ddc), it
  // is copied back to index.html so a follow-up chat adjustment revises the
  // version the user actually chose, not the newest one.
  app.post<{ Params: { sid: string; version: string } }>(
    "/api/sessions/:sid/artifacts/mp4/:version/restore",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) {
        reply.code(400).send({ error: "version must be a positive integer" });
        return;
      }
      // Artifact writes for a session belong to the orchestrator while a run
      // is in flight (ArtifactStore requires serialized writers).
      const state = await deps.orchestrator.getPersistedState(sid);
      if (state.kind === "running" || state.kind === "awaiting-gate" || state.kind === "awaiting-credits") {
        reply.code(409).send({ error: "a run is in progress — try again when it finishes" });
        return;
      }
      const env = await deps.artifacts.get<{ path: string }>(sid, "mp4", version);
      if (!env) {
        reply.code(404).send({ error: "artifact not found" });
        return;
      }
      const latest = await deps.artifacts.get<{ path: string }>(sid, "mp4");
      if (latest && latest.version === version) {
        reply.send({ restored: false, version });
        return;
      }

      // Best-effort composition rollback: only when this mp4's lineage names a
      // composition version whose snapshot survived (pre-snapshot sessions and
      // redeployed hosts restore the mp4 alone).
      const compRef = env.derivedFrom?.find((r) => r.kind === "composition");
      if (compRef) {
        const wsPaths = deps.workspaces.paths(sid);
        const compDir = wsPaths.composition;
        // Snapshots live in versions/; older sessions wrote them next to
        // index.html (moved out because a second root .html trips the
        // renderer's multiple_root_compositions lint).
        const snapshot = [
          join(wsPaths.versions, `index.v${compRef.version}.html`),
          join(compDir, `index.v${compRef.version}.html`),
        ].find((p) => existsSync(p));
        if (snapshot) {
          await copyFile(snapshot, join(compDir, "index.html"));
          const compEnv = await deps.artifacts.put(
            sid,
            "composition",
            { dir: "composition", entry: "index.html" },
            { derivedFrom: [{ kind: "composition", version: compRef.version }] },
          );
          // Keep the snapshot invariant: every composition version has one.
          await mkdir(wsPaths.versions, { recursive: true }).catch(() => undefined);
          await copyFile(snapshot, join(wsPaths.versions, `index.v${compEnv.version}.html`)).catch(() => undefined);
        }
      }

      const restored = await deps.artifacts.put(sid, "mp4", env.data, {
        derivedFrom: [{ kind: "mp4", version }],
      });
      reply.send({ restored: true, version: restored.version });
    },
  );
}
