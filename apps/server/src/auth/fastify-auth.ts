import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import type { AuthService, AuthUser } from "./auth-service.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the session guard for /api/sessions* routes. */
    authUser?: AuthUser;
  }
}

export function toWebHeaders(nodeHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.append(key, value);
  }
  return headers;
}

export interface AuthRoutesOptions {
  /** Public origin the browser uses (through the Next proxy). */
  publicOrigin: string;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  opts: AuthRoutesOptions,
): Promise<void> {
  // Bridge assumptions: better-auth core endpoints are GET/POST with JSON or
  // empty bodies. form_post OAuth providers (e.g. Apple) would need a
  // route-scoped urlencoded body parser before this handler.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (req, reply) => {
      const url = new URL(req.url, opts.publicOrigin);
      const headers = toWebHeaders(req.headers);
      // Fastify already parsed the body; we re-serialize it below, so the
      // original content-length no longer applies.
      headers.delete("content-length");
      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        ...(req.body !== undefined && req.body !== null
          ? { body: JSON.stringify(req.body) }
          : {}),
      });
      const response = await auth.handler(request);
      reply.status(response.status);
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length > 0) reply.header("set-cookie", setCookies);
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") reply.header(key, value);
      });
      if (response.body) reply.send(await response.text());
      else reply.send();
    },
  });
}

/** preHandler guarding /api/sessions* — 401 without a login session. */
export function createSessionGuard(auth: AuthService) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    // Match the routed pattern (percent-decoded, normalized by find-my-way),
    // not the raw URL — /api/%73essions routes to /api/sessions but would slip
    // past a raw-string prefix check.
    const routeUrl = req.routeOptions.url ?? "";
    const guarded =
      routeUrl === "/api/sessions" ||
      routeUrl.startsWith("/api/sessions/") ||
      routeUrl === "/api/credits" ||
      routeUrl.startsWith("/api/billing/");
    if (!guarded) return;
    const session = await auth.getSession(toWebHeaders(req.headers));
    if (!session) {
      reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    req.authUser = session.user;
    return;
  };
}
