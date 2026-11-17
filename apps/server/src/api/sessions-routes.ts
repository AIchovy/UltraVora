import { rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { SessionSummary } from "@ultracreator/shared";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { newSessionId } from "./session-id.js";
import { requireOwnedSession } from "./route-helpers.js";
import { sleepUnlessAborted } from "../retry.js";

export async function registerSessionsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const AutoApproveBodySchema = z.object({ autoApprove: z.boolean() });
  const CreateBodySchema = z.object({
    autoApprove: z.boolean().optional(),
    isPublic: z.boolean().optional(),
    productUrl: z
      .string()
      .url()
      .refine((u) => { try { const p = new URL(u).protocol; return p === "http:" || p === "https:"; } catch { return false; } }, "productUrl must be http(s)")
      .optional(),
  });

  app.post("/api/sessions", async (req, reply) => {
    const userId = req.authUser?.id;
    if (!userId) {
      // The guard already enforces auth on /api/sessions*; this is defense-in-depth.
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    // Tolerate a missing/empty body (autoApprove defaults false, private). A
    // present-but-malformed productUrl is a hard 400 (don't store junk links).
    const raw = req.body ?? {};
    const parsed = CreateBodySchema.safeParse(raw);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid body" });
      return;
    }
    const { autoApprove = false, isPublic = false, productUrl } = parsed.data;
    const sessionId = newSessionId();
    await deps.sessions.create({
      id: sessionId,
      userId,
      autoApprove,
      isPublic,
      productUrl: productUrl ?? null,
    });
    await deps.workspaces.init(sessionId);
    await deps.eventLog.attach(sessionId);
    reply.code(201).send({ sessionId });
  });

  app.get("/api/sessions", async (req, reply) => {
    const userId = req.authUser?.id;
    if (!userId) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const rows = await deps.sessions.listByUser(userId);
    const summaries: SessionSummary[] = rows.map((r): SessionSummary => ({
      id: r.id,
      title: r.title,
      status: r.status,
      currentPhase: r.currentPhase,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    reply.send(summaries);
  });

  app.get<{ Params: { sid: string } }>(
    "/api/sessions/:sid",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      // Durable status (rehydrates if this process hasn't touched the session),
      // so a parked/errored run survives a restart instead of reading as idle.
      const state = await deps.orchestrator.getPersistedState(sid);
      const artifacts = await deps.artifacts.list(sid);
      const row = await deps.sessions.get(sid);
      reply.send({ state, artifacts, title: row?.title ?? null, autoApprove: row?.autoApprove ?? false });
    },
  );

  app.patch<{ Params: { sid: string } }>(
    "/api/sessions/:sid",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      const parsed = AutoApproveBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid body" });
        return;
      }
      // Awaits the durable flag write; any resume runs in the background.
      await deps.orchestrator.setAutoApprove(sid, parsed.data.autoApprove);
      reply.code(204).send();
    },
  );

  // Resume a session parked in awaiting-credits (the in-session "Continue"
  // button after a top-up). No-op unless the session is actually parked there.
  app.post<{ Params: { sid: string } }>(
    "/api/sessions/:sid/resume",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      await deps.orchestrator.resumeCredits(sid);
      reply.code(202).send();
    },
  );

  app.delete<{ Params: { sid: string } }>(
    "/api/sessions/:sid",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      // Close the session's log writer (release fd) before rm, then drop the row.
      await deps.eventLog.close(sid);
      // Workspace first: an archive task enqueued after our deleteRemote then
      // finds an empty workspace and uploads nothing (no zombie re-uploads).
      await rm(deps.workspaces.paths(sid).root, { recursive: true, force: true });
      // GCS prefix before the row dies — the object keys embed userId. Both
      // best-effort AND time-bounded: deleteRemote queues behind any in-flight
      // archive (retry backoff can take minutes during an outage), and spec §8
      // says a bucket outage must not block the delete. On timeout the late
      // deleteRemote still runs (or no-ops once the row is gone); orphaned
      // objects fall under the documented manual-sweep posture.
      if (deps.media) {
        await Promise.race([
          deps.media.deleteRemote(sid).catch(() => undefined),
          sleepUnlessAborted(5000),
        ]);
      }
      await deps.sessions.delete(sid);
      // Row gone — drop the orchestrator's per-session in-memory state so it
      // doesn't linger until the next restart.
      deps.orchestrator.forget(sid);
      reply.code(204).send();
    },
  );
}
