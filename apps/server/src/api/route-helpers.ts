// apps/server/src/api/route-helpers.ts
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SessionRepository } from "../sessions/session-repository.js";
import { isValidSessionId } from "./session-id.js";

/**
 * Validate `:sid`, then assert the authenticated caller owns the session.
 * 400 on a malformed id; 404 when the row is absent OR owned by someone else
 * (404 not 403 — don't leak whether a session exists). Returns the sid, or
 * null after replying (caller must `return`). `req.authUser` is set by the
 * session guard for all /api/sessions* routes.
 */
export async function requireOwnedSession(
  req: FastifyRequest<{ Params: { sid: string } }>,
  reply: FastifyReply,
  sessions: SessionRepository,
): Promise<string | null> {
  const sid = req.params.sid;
  if (!isValidSessionId(sid)) {
    reply.code(400).send({ error: "invalid session id" });
    return null;
  }
  const row = await sessions.get(sid);
  if (!row || row.userId !== req.authUser?.id) {
    reply.code(404).send({ error: "session not found" });
    return null;
  }
  return sid;
}
