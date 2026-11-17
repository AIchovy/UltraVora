// apps/server/src/api/uploads-routes.ts
import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { requireOwnedSession } from "./route-helpers.js";

export async function registerUploadsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post<{ Params: { sid: string } }>(
    "/api/sessions/:sid/uploads",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      const saved: { name: string; path: string }[] = [];
      try {
        for await (const part of req.parts()) {
          if (part.type !== "file") continue;
          const buf = await part.toBuffer();
          const name = basename(part.filename ?? "upload.bin");
          // saveUpload may de-duplicate a colliding basename, so use the name it
          // actually stored — not the requested one — for the returned path.
          const stored = await deps.workspaces.saveUpload(sid, name, buf);
          const storedName = basename(stored);
          saved.push({ name: storedName, path: `uploads/${storedName}` });
        }
      } catch (err) {
        reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (saved.length === 0) {
        reply.code(400).send({ error: "no files in upload" });
        return;
      }
      reply.code(201).send({ files: saved });
    },
  );
}
