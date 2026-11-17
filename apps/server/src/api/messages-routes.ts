// apps/server/src/api/messages-routes.ts
import type { FastifyInstance } from "fastify";
import { UserMessageSchema } from "@ultracreator/shared";
import type { AppDeps } from "./app.js";
import { requireOwnedSession } from "./route-helpers.js";
import { deriveTitle } from "../sessions/derive-title.js";

export async function registerMessagesRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post<{ Params: { sid: string } }>(
    "/api/sessions/:sid/messages",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      const message = UserMessageSchema.parse(req.body);

      // Creem MoR content safety: every generative prompt is screened before
      // it enters the pipeline; flag and deny both block, and moderation
      // outages fail CLOSED (block, 503) per Creem's requirements. "/approve"
      // is the approval command, not a prompt — skip it.
      const creem = deps.creem;
      const text = message.text.trim();
      if (creem && text.length > 0 && text !== "/approve") {
        let decision: "allow" | "flag" | "deny";
        try {
          ({ decision } = await creem.client.moderatePrompt(text, sid));
        } catch (err) {
          req.log.error({ err, sid }, "prompt moderation unavailable — failing closed");
          reply.code(503).send({ error: "moderation_unavailable" });
          return;
        }
        if (decision !== "allow") {
          req.log.warn({ sid, decision }, "prompt blocked by content moderation");
          reply.code(422).send({ error: "content_policy" });
          return;
        }
      }

      await deps.sessions.setTitleIfEmpty(sid, deriveTitle(message.text));
      // Fire and forget — the pipeline is long-running and the client
      // observes progress via SSE, not via this response.
      void deps.orchestrator.handleMessage(sid, message).catch((err) => {
        app.log.error({ err, sid }, "orchestrator.handleMessage rejected");
      });
      reply.code(202).send({ accepted: true });
    },
  );
}
