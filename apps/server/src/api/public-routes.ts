// apps/server/src/api/public-routes.ts
import { isAbsolute, relative } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isPublicVideoSort } from "@ultracreator/shared";
import type { AppDeps } from "./app.js";
import { toWebHeaders } from "../auth/fastify-auth.js";
import { isValidSessionId } from "./session-id.js";
import { serveWorkspaceFile } from "./file-serving.js";

const LIST_LIMIT = 60;

/** Resolve the viewer id from the session cookie, or null when logged out. */
async function viewerId(deps: AppDeps, req: FastifyRequest): Promise<string | null> {
  const session = await deps.auth.getSession(toWebHeaders(req.headers));
  return session?.user.id ?? null;
}

interface Mp4Data {
  path: string;
}

export async function registerPublicRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const pv = deps.publicVideos;

  app.get<{ Querystring: { sort?: string } }>("/api/public/videos", async (req, reply) => {
    if (!pv) return reply.send([]);
    const sort = isPublicVideoSort(req.query.sort) ? req.query.sort : "recent";
    const list = await pv.list({ sort, limit: LIST_LIMIT, viewerId: await viewerId(deps, req) });
    return reply.send(list);
  });

  app.get<{ Params: { sid: string } }>("/api/public/videos/:sid", async (req, reply) => {
    if (!pv) return reply.code(404).send({ error: "not found" });
    const video = await pv.get(req.params.sid, await viewerId(deps, req));
    if (!video) return reply.code(404).send({ error: "video not found" });
    return reply.send(video);
  });

  app.get<{ Params: { sid: string } }>("/api/public/videos/:sid/video", async (req, reply) => {
    const sid = req.params.sid;
    if (!isValidSessionId(sid)) return reply.code(400).send({ error: "invalid session id" });
    const row = await deps.sessions.get(sid);
    if (!row || !row.isPublic || row.status !== "done") {
      return reply.code(404).send({ error: "video not found" });
    }
    const mp4 = await deps.artifacts.get<Mp4Data>(sid, "mp4");
    if (!mp4) return reply.code(404).send({ error: "video not found" });
    const root = deps.workspaces.paths(sid).root;
    // Legacy renders stored the worker's ABSOLUTE output path (newer ones are
    // workspace-relative). Normalize before serving: the relative form is also
    // the archive object key, so an absolute path breaks the signed-URL
    // fallback once the local copy is archived.
    const rel = isAbsolute(mp4.data.path) ? relative(root, mp4.data.path) : mp4.data.path;
    if (rel === ".." || rel.startsWith("../")) {
      return reply.code(404).send({ error: "video not found" });
    }
    return serveWorkspaceFile(req, reply, { root, relative: rel, sid, media: deps.media });
  });

  // Like helper — no isValidSessionId check here because the seeded fake sids
  // (e.g. "a") are valid per the [A-Za-z0-9_-]+ pattern anyway, but more
  // importantly: the repo returns null for unknown sids → 404 naturally, so an
  // extra format check adds no safety and would only constrain test data.
  const like = (fn: "like" | "unlike") => async (req: FastifyRequest<{ Params: { sid: string } }>, reply: FastifyReply) => {
    if (!pv) return reply.code(503).send({ error: "public_videos_disabled" });
    const uid = await viewerId(deps, req);
    if (!uid) return reply.code(401).send({ error: "unauthorized" });
    const sid = req.params.sid;
    const result = await pv[fn](sid, uid);
    if (!result) return reply.code(404).send({ error: "video not found" });
    return reply.send(result);
  };

  app.post<{ Params: { sid: string } }>("/api/public/videos/:sid/like", like("like"));
  app.delete<{ Params: { sid: string } }>("/api/public/videos/:sid/like", like("unlike"));
}
