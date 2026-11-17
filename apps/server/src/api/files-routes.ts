// apps/server/src/api/files-routes.ts
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { requireOwnedSession } from "./route-helpers.js";
import { serveWorkspaceFile } from "./file-serving.js";

export async function registerFilesRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<{ Params: { sid: string; "*": string } }>(
    "/api/sessions/:sid/files/*",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      const relative = req.params["*"];
      const root = deps.workspaces.paths(sid).root;
      return serveWorkspaceFile(req, reply, { root, relative, sid, media: deps.media });
    },
  );
}
