// apps/server/test/api/stream-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";
import { createApp, type AppDeps } from "../../src/api/app.js";
import { fakeAuthService } from "../helpers/fake-auth.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";
import type { ServerEvent } from "@ultracreator/shared";

interface ParsedFrame {
  id?: string;
  event?: string;
  data?: string;
}

async function* parseSseFrames(res: Response): AsyncGenerator<ParsedFrame> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let current: ParsedFrame = {};
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    while (true) {
      const idx = buf.indexOf("\n");
      if (idx < 0) break;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line === "") {
        if (current.data || current.event || current.id) yield current;
        current = {};
        continue;
      }
      if (line.startsWith(":")) continue; // comment / heartbeat
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const field = line.slice(0, colon);
      const val = line.slice(colon + 1).replace(/^ /, "");
      if (field === "id") current.id = val;
      else if (field === "event") current.event = val;
      else if (field === "data") current.data = current.data === undefined ? val : current.data + "\n" + val;
    }
  }
}

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let baseUrl: string;
let sessionId: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-stream-route-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const phases = new PhaseRegistry();
  const sessions = new InMemorySessionRepository();
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts, phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(),
    sessions,
    messages: new InMemoryMessageStore(),
  });
  const eventLog = new SessionEventLog({ events, store: new InMemoryEventStore(), batchMs: 0 });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog, auth: fakeAuthService(), sessions };
  app = await createApp(deps);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  sessionId = (await (await fetch(`${baseUrl}/api/sessions`, { method: "POST" })).json() as { sessionId: string }).sessionId;
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

function emit(n: number): ServerEvent {
  return { type: "phase.progress", phase: "research", message: `m${n}` };
}

describe("stream (SSE) route", () => {
  it("streams a single live event to a fresh subscriber", async () => {
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/stream`, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // give the route time to subscribe
    await new Promise((r) => setTimeout(r, 20));
    deps.events.emit(sessionId, emit(1));

    const frames: ParsedFrame[] = [];
    for await (const f of parseSseFrames(res)) {
      frames.push(f);
      if (frames.length === 1) break;
    }
    ac.abort();
    expect(frames[0]!.id).toBe("1");
    expect(frames[0]!.event).toBe("phase.progress");
    const data = JSON.parse(frames[0]!.data!);
    expect(data.event).toEqual(emit(1));
  });

  it("replays an event that is still in the batch buffer when the client connects", async () => {
    // Rebuild with a long batch window: the event stays in the buffer (never
    // auto-flushed), so only the route's flush-before-replay can surface it.
    await app.close();
    deps.eventLog = new SessionEventLog({ events: deps.events, store: new InMemoryEventStore(), batchMs: 10_000 });
    app = await createApp(deps);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    const sid = (await (await fetch(`${baseUrl}/api/sessions`, { method: "POST" })).json() as { sessionId: string }).sessionId;

    // Emitted after attach (POST attaches) but with no flush — sits in the buffer.
    deps.events.emit(sid, { type: "phase.progress", phase: "research", message: "buffered" });

    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/sessions/${sid}/stream`, { signal: ac.signal });
    expect(res.status).toBe(200);
    const frames: ParsedFrame[] = [];
    for await (const f of parseSseFrames(res)) {
      frames.push(f);
      if (frames.length === 1) break;
    }
    ac.abort();
    const data = JSON.parse(frames[0]!.data!);
    expect(data.event).toEqual({ type: "phase.progress", phase: "research", message: "buffered" });
  });

  it("replays past events from disk when Last-Event-Id is sent", async () => {
    deps.events.emit(sessionId, emit(1));
    deps.events.emit(sessionId, emit(2));
    deps.events.emit(sessionId, emit(3));
    await deps.eventLog.flush(sessionId);

    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/stream`, {
      signal: ac.signal,
      headers: { "Last-Event-Id": "1" },
    });
    expect(res.status).toBe(200);
    const frames: ParsedFrame[] = [];
    for await (const f of parseSseFrames(res)) {
      frames.push(f);
      if (frames.length === 2) break;
    }
    ac.abort();
    expect(frames.map((f) => f.id)).toEqual(["2", "3"]);
  });

  it("?lastEventId=N query parameter is honored when no header is set", async () => {
    deps.events.emit(sessionId, emit(1));
    deps.events.emit(sessionId, emit(2));
    await deps.eventLog.flush(sessionId);

    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/stream?lastEventId=1`, { signal: ac.signal });
    const frames: ParsedFrame[] = [];
    for await (const f of parseSseFrames(res)) {
      frames.push(f);
      if (frames.length === 1) break;
    }
    ac.abort();
    expect(frames[0]!.id).toBe("2");
  });

  it("drops nothing during the replay-to-live cutover (events fired during replay still arrive)", async () => {
    // Seed 50 events on disk, then start the stream and immediately emit 20 more.
    for (let i = 1; i <= 50; i++) deps.events.emit(sessionId, emit(i));
    await deps.eventLog.flush(sessionId);

    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/stream`, {
      signal: ac.signal,
      headers: { "Last-Event-Id": "0" },
    });
    // Don't await — fire live events as fast as we can, racing the replay loop.
    for (let i = 51; i <= 70; i++) deps.events.emit(sessionId, emit(i));

    const ids: number[] = [];
    for await (const f of parseSseFrames(res)) {
      if (f.id) ids.push(Number(f.id));
      if (ids.length === 70) break;
    }
    ac.abort();
    expect(ids).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));
  });

  it("replays the user's message to a fresh connection (the reopen-session case)", async () => {
    // Capture emission so we know the orchestrator recorded the turn before we
    // flush + reconnect. POST is fire-and-forget, so 202 precedes the emit.
    const seen: ServerEvent[] = [];
    deps.events.subscribe(sessionId, (e) => seen.push(e));
    await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "make me a promo", clientId: "c-77" }),
    });
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !seen.some((e) => e.type === "user.message")) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await deps.eventLog.flush(sessionId);

    // Fresh connection from seq 0 — exactly what reopening the session page does.
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/stream?lastEventId=0`, { signal: ac.signal });
    let found: ParsedFrame | undefined;
    let count = 0;
    for await (const f of parseSseFrames(res)) {
      if (f.event === "user.message") { found = f; break; }
      if (++count > 20) break;
    }
    ac.abort();
    expect(found).toBeDefined();
    const data = JSON.parse(found!.data!);
    expect(data.event).toMatchObject({ type: "user.message", text: "make me a promo", clientId: "c-77" });
  });

  it("returns 404 for unknown session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nope/stream`);
    expect(res.status).toBe(404);
    // drain so the fetch can release the socket
    await res.text();
  });

  it("unsubscribes from the EventBus when the client disconnects", async () => {
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/stream`, { signal: ac.signal });
    // wait for subscribe
    await new Promise((r) => setTimeout(r, 20));
    deps.events.emit(sessionId, emit(1));
    const reader = res.body!.getReader();
    await reader.read(); // pulls something
    ac.abort();
    // Give the server a tick to clean up.
    await new Promise((r) => setTimeout(r, 20));
    // After disconnect, emitting another event should not fail or leak.
    expect(() => deps.events.emit(sessionId, emit(2))).not.toThrow();
  });

  // reply.hijack() bypasses @fastify/cors, so the SSE response must mirror the
  // plugin's policy by hand. Prod is cross-origin (ultra-vora.com →
  // api.ultra-vora.com) with a credentialed EventSource: without
  // Access-Control-Allow-Credentials the browser discards the whole stream.
  describe("CORS headers on the hijacked response", () => {
    async function reopenWithAllowlist(allow: string[]): Promise<string> {
      await app.close();
      app = await createApp(deps, { corsOrigin: allow });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const addr = app.server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      const created = await (await fetch(`${baseUrl}/api/sessions`, { method: "POST" })).json() as { sessionId: string };
      return created.sessionId;
    }

    it("allows credentials for an allowlisted origin", async () => {
      const sid = await reopenWithAllowlist(["https://ultra-vora.com"]);
      const ac = new AbortController();
      const res = await fetch(`${baseUrl}/api/sessions/${sid}/stream`, {
        signal: ac.signal,
        headers: { Origin: "https://ultra-vora.com" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://ultra-vora.com");
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      ac.abort();
    });

    it("does not reflect an origin outside the allowlist", async () => {
      const sid = await reopenWithAllowlist(["https://ultra-vora.com"]);
      const ac = new AbortController();
      const res = await fetch(`${baseUrl}/api/sessions/${sid}/stream`, {
        signal: ac.signal,
        headers: { Origin: "https://evil.example" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      ac.abort();
    });

    it("keeps the dev default: reflect the origin, no credentials", async () => {
      // corsOrigin unset (`true`): same-origin dev — mirror @fastify/cors,
      // which reflects the origin but never grants credentials.
      const ac = new AbortController();
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/stream`, {
        signal: ac.signal,
        headers: { Origin: "http://localhost:3000" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      ac.abort();
    });
  });

  it("is 404 for a session owned by another user", async () => {
    const otherApp = await createApp({ ...deps, auth: fakeAuthService({ id: "intruder", email: "i@x.com", name: "I", image: null }) });
    const res = await otherApp.inject({ method: "GET", url: `/api/sessions/${sessionId}/stream` });
    expect(res.statusCode).toBe(404);
    await otherApp.close();
  });
});
