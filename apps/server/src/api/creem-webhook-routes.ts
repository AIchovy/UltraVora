import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { verifyCreemSignature } from "../billing/creem-client.js";
import { handleCreemEvent } from "../billing/creem-webhook.js";

/**
 * POST /api/webhooks/creem — Creem server→server events. Unauthenticated by
 * design (the session guard only covers /api/sessions*, /api/credits and
 * /api/billing/*): authenticity comes from the HMAC signature over the RAW
 * body. The raw-body content-type parser lives in an encapsulated plugin
 * scope so the rest of the app keeps Fastify's normal JSON parsing.
 */
export async function registerCreemWebhookRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const creem = deps.creem;
  const credits = deps.credits;
  if (!creem || !credits) return;

  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scope.post("/api/webhooks/creem", async (req, reply) => {
      const raw = req.body as Buffer;
      const signature = req.headers["creem-signature"];
      if (
        !verifyCreemSignature(
          raw,
          typeof signature === "string" ? signature : undefined,
          creem.config.webhookSecret,
        )
      ) {
        reply.code(401).send({ error: "bad_signature" });
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(raw.toString("utf8"));
      } catch {
        reply.code(400).send({ error: "bad_json" });
        return;
      }
      // Repository failures throw → 500 → Creem retries with the same event id;
      // idempotency keys make the retry safe.
      await handleCreemEvent(
        { credits, catalog: creem.config.products, log: (msg, data) => req.log.warn(data ?? {}, msg) },
        event,
      );
      reply.send({ received: true });
    });
  });
}
