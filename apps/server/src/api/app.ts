// apps/server/src/api/app.ts
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { EventBus } from "../events/event-bus.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { PhaseRegistry } from "../phases/registry.js";
import type { SessionOrchestrator } from "../orchestrator/session-orchestrator.js";
import type { SessionEventLog } from "../events/session-event-log.js";
import type { AuthService } from "../auth/auth-service.js";
import type { SessionRepository } from "../sessions/session-repository.js";
import type { SessionMediaArchive } from "../storage/session-media-archive.js";
import type { CreditRepository } from "../credits/credit-repository.js";
import type { PublicVideoRepository } from "../public/public-video-repository.js";
import type { CreemConfig } from "../billing/creem-config.js";
import type { CreemClient } from "../billing/creem-client.js";
import { registerAuthRoutes, createSessionGuard } from "../auth/fastify-auth.js";
import { registerSessionsRoutes } from "./sessions-routes.js";
import { registerBillingRoutes } from "./billing-routes.js";
import { registerCreemWebhookRoutes } from "./creem-webhook-routes.js";
import { registerUploadsRoutes } from "./uploads-routes.js";
import { registerMessagesRoutes } from "./messages-routes.js";
import { registerArtifactsRoutes } from "./artifacts-routes.js";
import { registerBriefAssetsRoutes } from "./brief-assets-routes.js";
import { registerFilesRoutes } from "./files-routes.js";
import { registerStreamRoutes } from "./stream-routes.js";
import { registerPublicRoutes } from "./public-routes.js";

export interface AppDeps {
  workspaces: WorkspaceManager;
  events: EventBus;
  artifacts: ArtifactStore;
  phases: PhaseRegistry;
  orchestrator: SessionOrchestrator;
  eventLog: SessionEventLog;
  auth: AuthService;
  sessions: SessionRepository;
  /** Optional: GCS-backed media archive (files-route fallback + delete cleanup). */
  media?: SessionMediaArchive;
  /** Optional: credit balance/ledger/subscription store (billing routes + gating). */
  credits?: CreditRepository;
  /** Optional: public-video read/like store (Product Plaza routes). */
  publicVideos?: PublicVideoRepository;
  /** Optional: Creem payment provider (real checkout + webhook). */
  creem?: { config: CreemConfig; client: CreemClient };
}

export interface CreateAppOptions {
  logger?: boolean;
  /** Bytes; passed through to @fastify/multipart's `fileSize`. */
  maxUploadBytes?: number;
  /** Public origin for /api/auth/* request reconstruction. */
  authPublicOrigin?: string;
  /** Allowed browser origin(s) for CORS. An allowlist enables credentialed
   *  cross-origin requests; `true` (default) reflects any origin WITHOUT
   *  credentials (dev/same-origin). */
  corsOrigin?: string[] | boolean;
  /** Register the DEV payment stubs (/api/billing/grant|subscribe). Default
   *  false: the routes are not registered at all and answer 404 — they mint
   *  credits with no payment, so production must never expose them. */
  billingStubs?: boolean;
  /** Browser origin used to build payment success redirects
   *  ({webOrigin}/billing/success). Defaults to same-origin dev
   *  (http://localhost:3000). */
  webOrigin?: string;
  /** Optional readiness probe for GET /healthz (e.g. a DB ping). A rejection
   *  turns /healthz into a 503. */
  healthCheck?: () => Promise<unknown>;
}

export function redactAuthUrl(url: string): string {
  if (!url.startsWith("/api/auth/")) return url;
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return url;
  return url.slice(0, qIdx) + "?[redacted]";
}

/**
 * Credentials are enabled ONLY for an explicit origin allowlist — never with
 * `origin: true`, which would reflect any site and let it issue authenticated
 * requests for a logged-in user.
 */
export function corsOptions(
  origin: string[] | boolean = true,
): { origin: string[] | boolean; credentials: boolean } {
  return typeof origin === "boolean"
    ? { origin, credentials: false }
    : { origin, credentials: true };
}

export async function createApp(deps: AppDeps, opts: CreateAppOptions = {}): Promise<FastifyInstance> {
  const loggerOption = opts.logger
    ? {
        serializers: {
          req(req: { method?: string; url?: string; ip?: string }) {
            const url = req.url ?? "";
            const redacted = redactAuthUrl(url);
            return { method: req.method, url: redacted, remoteAddress: req.ip };
          },
        },
      }
    : false;
  const app = Fastify({ logger: loggerOption });

  await app.register(cors, corsOptions(opts.corsOrigin));
  await app.register(multipart, {
    limits: { fileSize: opts.maxUploadBytes ?? 50 * 1024 * 1024 },
  });

  app.setErrorHandler<FastifyError>((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send({ error: "validation_failed", issues: err.issues });
      return;
    }
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  // Unauthenticated on purpose: uptime checks and deploy verification hit this
  // before any user exists. The session guard only covers /api/* routes.
  app.get("/healthz", async (_req, reply) => {
    try {
      if (opts.healthCheck) await opts.healthCheck();
    } catch {
      reply.code(503).send({ ok: false });
      return;
    }
    reply.send({ ok: true });
  });

  app.addHook("preHandler", createSessionGuard(deps.auth));
  await registerAuthRoutes(app, deps.auth, {
    publicOrigin: opts.authPublicOrigin ?? "http://localhost:3000",
  });

  await registerSessionsRoutes(app, deps);
  await registerBillingRoutes(app, deps, {
    stubs: opts.billingStubs ?? false,
    ...(opts.webOrigin ? { webOrigin: opts.webOrigin } : {}),
  });
  await registerCreemWebhookRoutes(app, deps);
  await registerUploadsRoutes(app, deps);
  await registerMessagesRoutes(app, deps);
  await registerArtifactsRoutes(app, deps);
  await registerBriefAssetsRoutes(app, deps);
  await registerFilesRoutes(app, deps);
  await registerStreamRoutes(app, deps, { corsOrigin: opts.corsOrigin });
  await registerPublicRoutes(app, deps);
  return app;
}
