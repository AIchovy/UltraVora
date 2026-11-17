// apps/server/src/api/stream-routes.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "./app.js";
import { requireOwnedSession } from "./route-helpers.js";
import { sseHeaders, writeSseFrame, writeSseHeartbeat } from "./sse-writer.js";
import type { SequencedEvent } from "../events/session-event-log.js";

export interface StreamRoutesOptions {
  heartbeatMs?: number;
  /** Same value as app.ts corsOptions: reply.hijack() bypasses @fastify/cors,
   *  so this route mirrors its policy by hand. An allowlist grants
   *  credentials (prod: browser EventSources are credentialed cross-origin,
   *  and without Access-Control-Allow-Credentials the browser rejects the
   *  stream); `true` reflects the origin WITHOUT credentials (dev). */
  corsOrigin?: string[] | boolean;
}

export function sseCorsHeaders(
  origin: string | undefined,
  allow: string[] | boolean,
): Record<string, string> {
  if (!origin) return {};
  if (Array.isArray(allow)) {
    if (!allow.includes(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    };
  }
  return allow ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
}

export async function registerStreamRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  opts: StreamRoutesOptions = {},
): Promise<void> {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const corsOrigin = opts.corsOrigin ?? true;

  app.get<{ Params: { sid: string }; Querystring: { lastEventId?: string } }>(
    "/api/sessions/:sid/stream",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;

      const sinceSeq = parseSince(req);
      await deps.eventLog.attach(sid);

      // Take over the raw response.  reply.hijack() bypasses Fastify
      // plugins (including @fastify/cors), so we mirror its policy manually.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        ...sseHeaders(),
        ...sseCorsHeaders(req.headers.origin, corsOrigin),
      });
      // Write an initial comment to flush response headers to the client.
      // Without this, Node.js buffers writeHead until the first write().
      raw.write(": connected\n\n");

      const sink = { write: (chunk: string) => raw.write(chunk) };

      // Subscribe first; capture into a buffer until cutover.
      let lastSent = sinceSeq;
      let mode: "buffer" | "live" = "buffer";
      // v1: unbounded during replay. Acceptable because v1 is single-user; the
      // PG replay query completes quickly. Bound this in v2 if a session's event
      // log can grow into the hundreds of thousands of entries.
      const buffered: SequencedEvent[] = [];
      const unsubscribe = deps.eventLog.subscribe(sid, (entry) => {
        if (mode === "buffer") buffered.push(entry);
        else if (entry.seq > lastSent) {
          writeSseFrame(sink, entry);
          lastSent = entry.seq;
        }
      });

      const heartbeat = setInterval(() => writeSseHeartbeat(sink), heartbeatMs);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        unsubscribe();
        // End the raw response so app.close() can drain cleanly.
        if (!raw.writableEnded) raw.end();
      };

      req.raw.on("close", cleanup);

      // Persist anything still in the batch buffer so the PG replay below sees
      // it. Subscribe already happened, so events arriving during the flush are
      // captured in `buffered` and drained after cutover (seq dedup prevents
      // doubles).
      await deps.eventLog.flush(sid);

      try {
        // Replay persisted events from PG.
        for await (const entry of deps.eventLog.readSince(sid, sinceSeq)) {
          if (entry.seq > lastSent) {
            writeSseFrame(sink, entry);
            lastSent = entry.seq;
          }
        }
        // Atomic cutover: drain buffer + flip mode in one synchronous block
        // so no live callback can interleave.
        const toDrain = buffered.splice(0);
        mode = "live";
        for (const entry of toDrain) {
          if (entry.seq > lastSent) {
            writeSseFrame(sink, entry);
            lastSent = entry.seq;
          }
        }
      } catch (err) {
        cleanup();
        return;
      }
      // The reply stays open until the client disconnects (handled above).
    },
  );
}

function parseSince(
  req: FastifyRequest<{ Params: { sid: string }; Querystring: { lastEventId?: string } }>,
): number {
  const header = req.headers["last-event-id"];
  if (typeof header === "string" && /^\d+$/.test(header)) return Number(header);
  const q = req.query.lastEventId;
  if (typeof q === "string" && /^\d+$/.test(q)) return Number(q);
  return 0;
}
