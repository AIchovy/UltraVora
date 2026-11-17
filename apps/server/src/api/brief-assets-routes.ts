// apps/server/src/api/brief-assets-routes.ts
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Brief } from "@ultracreator/shared";
import type { AppDeps } from "./app.js";
import { requireOwnedSession } from "./route-helpers.js";

interface PatchAssetsBody {
  add?: string[];
  remove?: string[];
}

/**
 * Curate the brief's source images between phases: low-quality captured
 * screenshots drag every downstream artifact down (design keyVisuals, compose
 * embeds), so the user can drop them and upload better shots at a review gate.
 * Writes a new brief version; downstream phases read the latest brief when
 * they (re-)run.
 */
export async function registerBriefAssetsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.patch<{ Params: { sid: string }; Body: PatchAssetsBody }>(
    "/api/sessions/:sid/brief/assets",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;

      const add = req.body?.add ?? [];
      const remove = req.body?.remove ?? [];
      const isStringArray = (v: unknown): v is string[] =>
        Array.isArray(v) && v.every((s) => typeof s === "string");
      if (!isStringArray(add) || !isStringArray(remove)) {
        return reply.code(400).send({ error: "add/remove must be arrays of workspace-relative paths" });
      }
      if (add.length === 0 && remove.length === 0) {
        return reply.code(400).send({ error: "nothing to change" });
      }

      // Artifact writes belong to the orchestrator while a phase is actively
      // producing; curation happens at review gates, idle, done or error.
      const state = await deps.orchestrator.getPersistedState(sid);
      if (state.kind === "running") {
        return reply.code(409).send({ error: "a phase is running — try again at the next review point" });
      }

      const briefEnv = await deps.artifacts.get<Brief>(sid, "brief");
      if (!briefEnv) {
        return reply.code(404).send({ error: "no brief yet" });
      }

      const root = deps.workspaces.paths(sid).root;
      const safeAbs = (rel: string): string | null => {
        if (isAbsolute(rel)) return null;
        const abs = normalize(join(root, rel));
        const within = relative(root, abs);
        if (within.startsWith("..") || isAbsolute(within)) return null;
        return abs;
      };

      for (const rel of add) {
        const abs = safeAbs(rel);
        if (!abs) return reply.code(400).send({ error: `path escapes workspace: ${rel}` });
        if (!existsSync(abs)) return reply.code(400).send({ error: `file not found: ${rel}` });
      }

      const removeSet = new Set(remove);
      const kept = briefEnv.data.sourceAssets.images.filter((p) => !removeSet.has(p));
      const images = [...new Set([...kept, ...add])];

      // Compose sweeps EVERY file in assets/ into the composition regardless
      // of the brief listing (design-generated images), so removing an
      // assets/ entry must also delete the file or it resurfaces. Captured
      // (capture/…) and uploaded (uploads/…) files are only ever pulled in
      // via the brief, so their bytes can stay for forensics/re-adding.
      // A previous compose may also have copied the image NEXT TO index.html
      // (by basename), and revision runs list every file there as a reusable
      // asset — delete that copy too, unless a kept image owns the same
      // basename.
      const keptBasenames = new Set(images.map((p) => basename(p)));
      const compositionDir = deps.workspaces.paths(sid).composition;
      for (const rel of remove) {
        const name = basename(rel);
        if (name && !keptBasenames.has(name)) {
          await unlink(join(compositionDir, name)).catch(() => undefined);
        }
        if (!rel.startsWith("assets/")) continue;
        const abs = safeAbs(rel);
        if (abs) await unlink(abs).catch(() => undefined);
      }

      const next: Brief = {
        ...briefEnv.data,
        sourceAssets: { ...briefEnv.data.sourceAssets, images },
      };
      const env = await deps.artifacts.put(sid, "brief", next, {
        derivedFrom: [{ kind: "brief", version: briefEnv.version }],
      });
      reply.send(env);
    },
  );
}
