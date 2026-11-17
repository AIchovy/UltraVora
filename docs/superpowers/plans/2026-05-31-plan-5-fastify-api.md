# UltraCreator Plan 5 — Fastify API + SSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the `composeOrchestrator` graph (Plans 1–4) over HTTP. Build a Fastify server with REST routes for sessions, uploads, messages, and artifacts; a Server-Sent Events stream that replays every event a session has ever emitted (so reconnects are seamless); and a per-session `events.jsonl` event log on disk. After Plan 5 the backend is fully driveable from any HTTP client and ready for the Next.js frontend in Plan 6.

**Architecture:** Fastify v5 in a single Node process. `createApp(deps)` accepts an injected `ComposedOrchestrator` plus a `SessionEventLog` and registers all routes — keeping the routes test-friendly (no real LLM/render needed) and the bootstrap (`server.ts`) tiny. The orchestrator's existing `EventBus` is *unchanged*: a new `SessionEventLog` subscribes to it, stamps each event with a per-session monotonic sequence number, appends it to `workspaces/<sid>/logs/events.jsonl`, and republishes a `{seq, at, event}` envelope to live SSE subscribers. SSE clients reconnect using the standard `Last-Event-Id` header and the route replays from the log file, then drains a buffer of events that arrived during replay, then goes live — no events dropped, no duplicates after the cutover. File downloads (mp4, narration) are served with `Range` support so the browser `<video>` element can seek.

**Tech Stack:** Fastify v5, `@fastify/multipart` v9 (file uploads), `@fastify/cors` v10 (frontend on a different origin), Node `node:fs` streams (range serving + jsonl), `node:crypto.randomUUID` (session ids), zod (request validation — already a dep), vitest + Fastify `inject()` for routes + native `fetch` + an abort-controlled real listen for SSE.

**Roadmap context:** Plan 5 of 6. Plans 1 (foundation), 2 (orchestrator), 3 (Pi-agent phases + providers), and 4 (RenderWorker) are merged. After Plan 5 the backend is a self-contained HTTP service that can drive the full pipeline end-to-end via REST + SSE. Plan 6 builds the Next.js frontend on top of these routes.

---

## File Structure

```
apps/server/
  package.json                      # + fastify, @fastify/multipart, @fastify/cors; bin: ultracreator-server
  src/
    api/
      app.ts                        # createApp(deps) → FastifyInstance, registers everything
      server.ts                     # bin entry: composeOrchestrator + createApp + listen
      session-id.ts                 # newSessionId(): random UUID; validateSessionId(s)
      route-helpers.ts              # wrapWorkspaceError, requireSession (404 if no dir)
      sessions-routes.ts            # POST/GET/DELETE /api/sessions[/:sid]
      uploads-routes.ts             # POST /api/sessions/:sid/uploads
      messages-routes.ts            # POST /api/sessions/:sid/messages
      artifacts-routes.ts           # GET /api/sessions/:sid/artifacts[/:kind]
      files-routes.ts               # GET /api/sessions/:sid/files/* (range-supported)
      stream-routes.ts              # GET /api/sessions/:sid/stream (SSE)
      sse-writer.ts                 # low-level SSE writer (frame + heartbeat)
    events/
      session-event-log.ts          # subscribe(EventBus) → append jsonl + republish sequenced
  test/
    api/
      session-event-log.test.ts
      sse-writer.test.ts
      session-id.test.ts
      sessions-routes.test.ts
      uploads-routes.test.ts
      messages-routes.test.ts
      artifacts-routes.test.ts
      files-routes.test.ts
      stream-routes.test.ts         # uses real listen + fetch + AbortController
      end-to-end.test.ts            # full happy path through HTTP with fake handlers
```

**Responsibility boundaries:**
- `SessionEventLog` — the *only* component that writes `events.jsonl`. Assigns sequence numbers; broadcasts sequenced envelopes; does not understand HTTP.
- `sse-writer.ts` — knows the SSE wire format and nothing else. Stateless functions over a `ServerResponse`.
- Each route file owns one HTTP surface and validates with zod at the boundary; orchestrator interactions are fire-and-forget for the long-running ones.
- `app.ts` registers plugins (`@fastify/multipart`, `@fastify/cors`), the error handler, and every route module. No business logic.
- `server.ts` is the *only* file that calls `composeOrchestrator(...)` at runtime (tests build their own deps with `composeOrchestrator` + `StubRenderWorkerClient`).

---

## Task 1: Install Fastify deps and add server bin script

**Files:**
- Modify: `apps/server/package.json`
- Modify: `package.json` (root) — add `dev:server` script

- [ ] **Step 1: Add the deps**

Run from the repo root:

```bash
pnpm add -F @ultracreator/server fastify@^5.2.0 @fastify/multipart@^9.0.1 @fastify/cors@^10.0.1
pnpm add -F @ultracreator/server -D form-data@^4.0.1 @types/node@^24.0.0
```

`form-data` is dev-only — only used by tests to build multipart bodies for `app.inject`.

- [ ] **Step 2: Add the bin entry and dev script to `apps/server/package.json`**

After installing, the file should look like:

```json
{
  "name": "@ultracreator/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "ultracreator-server": "src/api/server.ts"
  },
  "scripts": {
    "dev": "tsx watch src/api/server.ts",
    "start": "tsx src/api/server.ts"
  },
  "dependencies": {
    "@earendil-works/pi-agent-core": "^0.78.0",
    "@earendil-works/pi-ai": "^0.78.0",
    "@fastify/cors": "^10.0.1",
    "@fastify/multipart": "^9.0.1",
    "@google/genai": "^2.7.0",
    "@ultracreator/shared": "workspace:*",
    "fastify": "^5.2.0",
    "typebox": "^1.1.39",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "form-data": "^4.0.1",
    "hyperframes": "^0.6.63"
  }
}
```

- [ ] **Step 3: Add the root dev script**

Edit the root `package.json`'s `scripts`:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:external": "vitest run -c vitest.external.config.ts",
    "typecheck": "pnpm -r exec tsc --noEmit",
    "dev:server": "pnpm -F @ultracreator/server dev"
  }
}
```

- [ ] **Step 4: Verify the install**

Run: `pnpm install`
Expected: completes without errors; `node_modules/fastify` and `node_modules/@fastify/multipart` exist.

Run: `pnpm typecheck`
Expected: passes (no new TS, so this just confirms nothing broke).

- [ ] **Step 5: Commit**

```bash
git add apps/server/package.json package.json pnpm-lock.yaml
git commit -m "chore(server): install fastify, multipart, cors deps for Plan 5"
```

---

## Task 2: SessionEventLog — write the failing tests

**Files:**
- Create: `apps/server/test/api/session-event-log.test.ts`

The component we're about to build wraps the `EventBus` so that every event the orchestrator emits gets:
1. A monotonic `seq` number per session (starts at 1, never resets, never gaps).
2. An ISO `at` timestamp.
3. An append to `workspaces/<sid>/logs/events.jsonl` (one JSON object per line).
4. A re-broadcast to live `(sid, seqEnvelope)` listeners (the SSE route).

Tests first.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/test/api/session-event-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@ultracreator/shared";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";

let root: string;
let events: EventBus;
let workspaces: WorkspaceManager;
let log: SessionEventLog;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-evlog-"));
  events = new EventBus();
  workspaces = new WorkspaceManager(root);
  log = new SessionEventLog({ events, workspaces });
  await workspaces.init("s1");
});

afterEach(async () => {
  await log.closeAll();
  rmSync(root, { recursive: true, force: true });
});

const ev = (i: number): ServerEvent => ({
  type: "phase.progress",
  phase: "research",
  message: `msg-${i}`,
});

describe("SessionEventLog", () => {
  it("attach() subscribes to the EventBus and writes one JSON line per event", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    await log.flush("s1");
    const text = readFileSync(join(root, "s1/logs/events.jsonl"), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]!);
    const b = JSON.parse(lines[1]!);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.event).toEqual(ev(1));
    expect(b.event).toEqual(ev(2));
    expect(typeof a.at).toBe("string");
  });

  it("re-broadcasts sequenced envelopes to subscribers in order", async () => {
    await log.attach("s1");
    const seen: Array<{ seq: number; event: ServerEvent }> = [];
    log.subscribe("s1", (entry) => seen.push({ seq: entry.seq, event: entry.event }));
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    expect(seen).toEqual([
      { seq: 1, event: ev(1) },
      { seq: 2, event: ev(2) },
    ]);
  });

  it("attach() resumes sequence numbering from an existing jsonl file", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    await log.closeAll();
    log = new SessionEventLog({ events, workspaces });
    await log.attach("s1");
    events.emit("s1", ev(3));
    await log.flush("s1");
    const lines = readFileSync(join(root, "s1/logs/events.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!).seq).toBe(3);
  });

  it("readSince(sid, sinceSeq) yields only events with seq > sinceSeq", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    events.emit("s1", ev(3));
    await log.flush("s1");
    const collected: number[] = [];
    for await (const entry of log.readSince("s1", 1)) collected.push(entry.seq);
    expect(collected).toEqual([2, 3]);
  });

  it("readSince(sid, 0) yields every event from the start", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    await log.flush("s1");
    const collected: number[] = [];
    for await (const entry of log.readSince("s1", 0)) collected.push(entry.seq);
    expect(collected).toEqual([1, 2]);
  });

  it("readSince returns an empty iterator if the log file does not exist yet", async () => {
    await workspaces.init("s2");
    const seen: number[] = [];
    for await (const e of log.readSince("s2", 0)) seen.push(e.seq);
    expect(seen).toEqual([]);
  });

  it("closeAll() stops further appends and broadcasts", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    await log.closeAll();
    const seen: number[] = [];
    log.subscribe("s1", (e) => seen.push(e.seq));
    events.emit("s1", ev(2));
    expect(seen).toEqual([]);
    const lines = existsSync(join(root, "s1/logs/events.jsonl"))
      ? readFileSync(join(root, "s1/logs/events.jsonl"), "utf8").trim().split("\n").filter(Boolean)
      : [];
    expect(lines).toHaveLength(1);
  });

  it("subscribe() unsub stops only that listener (does not unsubscribe from EventBus)", async () => {
    await log.attach("s1");
    const a: number[] = [];
    const b: number[] = [];
    const offA = log.subscribe("s1", (e) => a.push(e.seq));
    log.subscribe("s1", (e) => b.push(e.seq));
    events.emit("s1", ev(1));
    offA();
    events.emit("s1", ev(2));
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/server/test/api/session-event-log.test.ts`
Expected: FAIL — cannot find module `../../src/events/session-event-log.js`.

---

## Task 3: SessionEventLog — implement and pass

**Files:**
- Create: `apps/server/src/events/session-event-log.ts`

- [ ] **Step 1: Write the implementation**

```ts
// apps/server/src/events/session-event-log.ts
import { createReadStream, createWriteStream, existsSync, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ServerEvent } from "@ultracreator/shared";
import type { EventBus } from "./event-bus.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

export interface SequencedEvent {
  seq: number;
  at: string;
  event: ServerEvent;
}

export type SequencedListener = (entry: SequencedEvent) => void;

interface SessionState {
  stream: WriteStream;
  nextSeq: number;
  subscribers: Set<SequencedListener>;
  unsubFromBus: () => void;
  pendingWrites: Promise<unknown>;
}

export interface SessionEventLogDeps {
  events: EventBus;
  workspaces: WorkspaceManager;
}

/**
 * Sits between the orchestrator's EventBus and live SSE clients.
 *
 * - On `attach(sid)`: open `workspaces/<sid>/logs/events.jsonl` for append,
 *   recover the next sequence number from the existing line count, and
 *   subscribe to the bus.
 * - On each bus event: stamp it with a per-session monotonic `seq` + ISO `at`,
 *   write a JSON line, and broadcast `{seq, at, event}` to live subscribers.
 * - `readSince(sid, sinceSeq)` streams persisted events from disk for replay.
 *
 * The file is the source of truth for sequence numbers; subscribers see the
 * exact same envelopes that the file holds. Reconnect-without-loss is the
 * responsibility of the SSE route (subscribe → read → drain → live).
 */
export class SessionEventLog {
  private states = new Map<string, SessionState>();

  constructor(private deps: SessionEventLogDeps) {}

  async attach(sessionId: string): Promise<void> {
    if (this.states.has(sessionId)) return;
    const logsDir = this.deps.workspaces.paths(sessionId).logs;
    const path = join(logsDir, "events.jsonl");
    const nextSeq = await this.recoverNextSeq(path);
    const stream = createWriteStream(path, { flags: "a" });
    const subscribers = new Set<SequencedListener>();
    const state: SessionState = {
      stream,
      nextSeq,
      subscribers,
      unsubFromBus: () => {},
      pendingWrites: Promise.resolve(),
    };
    state.unsubFromBus = this.deps.events.subscribe(sessionId, (event) => {
      const entry: SequencedEvent = {
        seq: state.nextSeq++,
        at: new Date().toISOString(),
        event,
      };
      const write = new Promise<void>((resolve) => {
        state.stream.write(JSON.stringify(entry) + "\n", () => resolve());
      });
      state.pendingWrites = write;
      for (const sub of [...subscribers]) sub(entry);
    });
    this.states.set(sessionId, state);
  }

  subscribe(sessionId: string, listener: SequencedListener): () => void {
    const state = this.states.get(sessionId);
    if (!state) return () => {};
    state.subscribers.add(listener);
    return () => {
      state.subscribers.delete(listener);
    };
  }

  async *readSince(sessionId: string, sinceSeq: number): AsyncIterable<SequencedEvent> {
    const path = join(this.deps.workspaces.paths(sessionId).logs, "events.jsonl");
    if (!existsSync(path)) return;
    const rl = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      const entry = JSON.parse(line) as SequencedEvent;
      if (entry.seq > sinceSeq) yield entry;
    }
  }

  async flush(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;
    await state.pendingWrites;
  }

  async closeAll(): Promise<void> {
    const states = [...this.states.values()];
    this.states.clear();
    for (const state of states) {
      state.unsubFromBus();
      state.subscribers.clear();
      await state.pendingWrites;
      await new Promise<void>((resolve) => state.stream.end(() => resolve()));
    }
  }

  private async recoverNextSeq(path: string): Promise<number> {
    if (!existsSync(path)) return 1;
    const txt = await readFile(path, "utf8");
    const lines = txt.split("\n").filter((l) => l.length > 0);
    return lines.length + 1;
  }
}
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `pnpm vitest run apps/server/test/api/session-event-log.test.ts`
Expected: PASS — 8 tests green.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/events/session-event-log.ts apps/server/test/api/session-event-log.test.ts
git commit -m "feat(server): SessionEventLog — jsonl persistence + sequenced re-broadcast"
```

---

## Task 4: SSE writer — failing tests

**Files:**
- Create: `apps/server/test/api/sse-writer.test.ts`

We need a small helper that knows the SSE wire format (`id:`, `event:`, `data:`, blank line) and nothing else. Stateless functions over a `ServerResponse`-like sink so we can fake it in tests.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/test/api/sse-writer.test.ts
import { describe, it, expect, vi } from "vitest";
import { writeSseFrame, writeSseHeartbeat, sseHeaders } from "../../src/api/sse-writer.js";
import type { SequencedEvent } from "../../src/events/session-event-log.js";

function fakeSink() {
  const chunks: string[] = [];
  return {
    chunks,
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
  };
}

describe("sse-writer", () => {
  it("sseHeaders returns the standard SSE headers including no-cache and keep-alive", () => {
    expect(sseHeaders()).toEqual({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  });

  it("writeSseFrame emits id/event/data lines with JSON payload and trailing blank line", () => {
    const sink = fakeSink();
    const entry: SequencedEvent = {
      seq: 7,
      at: "2026-05-31T12:00:00.000Z",
      event: { type: "phase.progress", phase: "research", message: "hi" },
    };
    writeSseFrame(sink, entry);
    expect(sink.chunks.join("")).toBe(
      `id: 7\nevent: phase.progress\ndata: ${JSON.stringify(entry)}\n\n`,
    );
  });

  it("writeSseFrame splits embedded newlines in JSON into multiple data: lines (per spec)", () => {
    const sink = fakeSink();
    const entry: SequencedEvent = {
      seq: 1,
      at: "2026-05-31T12:00:00.000Z",
      // A literal newline in a string field forces multi-line data.
      event: { type: "phase.progress", phase: "research", message: "a\nb" },
    };
    writeSseFrame(sink, entry);
    const joined = sink.chunks.join("");
    // The entry JSON contains an escaped \n inside the string, so the
    // serialized form is single-line — assert no raw newline leaks into the
    // payload.
    expect(joined.split("\n\n")).toHaveLength(2); // one frame + trailing blank
    const dataLines = joined.split("\n").filter((l) => l.startsWith("data: "));
    expect(dataLines).toHaveLength(1);
  });

  it("writeSseHeartbeat emits a comment frame (\": ping\\n\\n\")", () => {
    const sink = fakeSink();
    writeSseHeartbeat(sink);
    expect(sink.chunks.join("")).toBe(": ping\n\n");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/server/test/api/sse-writer.test.ts`
Expected: FAIL — module `../../src/api/sse-writer.js` not found.

---

## Task 5: SSE writer — implement

**Files:**
- Create: `apps/server/src/api/sse-writer.ts`

- [ ] **Step 1: Write the implementation**

```ts
// apps/server/src/api/sse-writer.ts
import type { SequencedEvent } from "../events/session-event-log.js";

export interface SseSink {
  write(chunk: string): boolean;
}

export function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering (nginx, etc.) so events flush immediately.
    "X-Accel-Buffering": "no",
  };
}

export function writeSseFrame(sink: SseSink, entry: SequencedEvent): void {
  const payload = JSON.stringify(entry);
  sink.write(`id: ${entry.seq}\nevent: ${entry.event.type}\ndata: ${payload}\n\n`);
}

export function writeSseHeartbeat(sink: SseSink): void {
  sink.write(": ping\n\n");
}
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `pnpm vitest run apps/server/test/api/sse-writer.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/api/sse-writer.ts apps/server/test/api/sse-writer.test.ts
git commit -m "feat(server): sse-writer — frame + heartbeat + headers helpers"
```

---

## Task 6: Session id helpers + tests

**Files:**
- Create: `apps/server/src/api/session-id.ts`
- Create: `apps/server/test/api/session-id.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/test/api/session-id.test.ts
import { describe, it, expect } from "vitest";
import { newSessionId, isValidSessionId } from "../../src/api/session-id.js";

describe("session-id", () => {
  it("newSessionId returns a 36-char UUID v4", () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("newSessionId is unique across calls", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).not.toBe(b);
  });

  it("isValidSessionId accepts alphanumeric + hyphen + underscore", () => {
    expect(isValidSessionId(newSessionId())).toBe(true);
    expect(isValidSessionId("abc_123-XYZ")).toBe(true);
  });

  it("isValidSessionId rejects empty / slashes / dots / spaces", () => {
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("../foo")).toBe(false);
    expect(isValidSessionId("a/b")).toBe(false);
    expect(isValidSessionId("a b")).toBe(false);
    expect(isValidSessionId("a.b")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/server/test/api/session-id.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/server/src/api/session-id.ts
import { randomUUID } from "node:crypto";

// MUST stay in sync with WorkspaceManager.SESSION_ID_PATTERN.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function newSessionId(): string {
  return randomUUID();
}

export function isValidSessionId(id: string): boolean {
  return id.length > 0 && SESSION_ID_PATTERN.test(id);
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm vitest run apps/server/test/api/session-id.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api/session-id.ts apps/server/test/api/session-id.test.ts
git commit -m "feat(server): session id helpers (UUID v4, validator)"
```

---

## Task 7: createApp skeleton + sessions routes

**Files:**
- Create: `apps/server/src/api/app.ts`
- Create: `apps/server/src/api/route-helpers.ts`
- Create: `apps/server/src/api/sessions-routes.ts`
- Create: `apps/server/test/api/sessions-routes.test.ts`

This is the first task that produces a runnable Fastify app. We register CORS, multipart, an error handler that maps zod errors to 400, and the `/api/sessions` routes:
- `POST /api/sessions` → create workspace, attach event log, return `{ sessionId }`
- `GET /api/sessions/:sid` → `{ state, artifacts }`
- `DELETE /api/sessions/:sid` → close event log, rm -rf workspace, 204

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/test/api/sessions-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { createApp, type AppDeps } from "../../src/api/app.js";

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-sess-route-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(workspaces, events);
  const phases = new PhaseRegistry();
  const orchestrator = new SessionOrchestrator({
    workspaces,
    events,
    artifacts,
    phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(),
  });
  const eventLog = new SessionEventLog({ events, workspaces });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog };
  app = await createApp(deps);
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("sessions routes", () => {
  it("POST /api/sessions returns a session id and creates the workspace dirs", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { sessionId: string };
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(join(root, body.sessionId, "uploads"))).toBe(true);
    expect(existsSync(join(root, body.sessionId, "artifacts"))).toBe(true);
    expect(existsSync(join(root, body.sessionId, "logs"))).toBe(true);
  });

  it("POST /api/sessions attaches the event log so emits get persisted", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = res.json() as { sessionId: string };
    deps.events.emit(sessionId, {
      type: "phase.progress",
      phase: "research",
      message: "hello",
    });
    await deps.eventLog.flush(sessionId);
    const logPath = join(root, sessionId, "logs/events.jsonl");
    expect(existsSync(logPath)).toBe(true);
  });

  it("GET /api/sessions/:sid returns state=idle and empty artifacts for a fresh session", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: { kind: "idle" }, artifacts: [] });
  });

  it("GET /api/sessions/:sid returns 404 for an unknown session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/sessions/:sid returns 400 for an invalid id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/has..slash" });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /api/sessions/:sid removes the workspace and closes the event log", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(204);
    expect(existsSync(join(root, sessionId))).toBe(false);
  });

  it("DELETE /api/sessions/:sid is 404 if the session does not exist", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/sessions/nope" });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/server/test/api/sessions-routes.test.ts`
Expected: FAIL — `../../src/api/app.js` not found.

- [ ] **Step 3: Write the route helpers**

```ts
// apps/server/src/api/route-helpers.ts
import { existsSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import { isValidSessionId } from "./session-id.js";

/**
 * Validate `:sid` from the route params, 400 if malformed, 404 if no workspace.
 * Returns the (validated) session id on success, or `null` after replying with
 * an error — the caller should `return` in that case.
 */
export function requireSession(
  req: FastifyRequest<{ Params: { sid: string } }>,
  reply: FastifyReply,
  workspaces: WorkspaceManager,
): string | null {
  const sid = req.params.sid;
  if (!isValidSessionId(sid)) {
    reply.code(400).send({ error: "invalid session id" });
    return null;
  }
  if (!existsSync(workspaces.paths(sid).root)) {
    reply.code(404).send({ error: "session not found" });
    return null;
  }
  return sid;
}
```

- [ ] **Step 4: Write the app skeleton**

```ts
// apps/server/src/api/app.ts
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { EventBus } from "../events/event-bus.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { PhaseRegistry } from "../phases/registry.js";
import type { SessionOrchestrator } from "../orchestrator/session-orchestrator.js";
import type { SessionEventLog } from "../events/session-event-log.js";
import { registerSessionsRoutes } from "./sessions-routes.js";

export interface AppDeps {
  workspaces: WorkspaceManager;
  events: EventBus;
  artifacts: ArtifactStore;
  phases: PhaseRegistry;
  orchestrator: SessionOrchestrator;
  eventLog: SessionEventLog;
}

export interface CreateAppOptions {
  logger?: boolean;
  /** Bytes; passed through to @fastify/multipart's `fileSize`. */
  maxUploadBytes?: number;
}

export async function createApp(deps: AppDeps, opts: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: opts.maxUploadBytes ?? 50 * 1024 * 1024 },
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send({ error: "validation_failed", issues: err.issues });
      return;
    }
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  await registerSessionsRoutes(app, deps);
  return app;
}
```

- [ ] **Step 5: Write the sessions routes**

```ts
// apps/server/src/api/sessions-routes.ts
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { newSessionId, isValidSessionId } from "./session-id.js";
import { requireSession } from "./route-helpers.js";

export async function registerSessionsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post("/api/sessions", async (_req, reply) => {
    const sessionId = newSessionId();
    await deps.workspaces.init(sessionId);
    await deps.eventLog.attach(sessionId);
    reply.code(201).send({ sessionId });
  });

  app.get<{ Params: { sid: string } }>(
    "/api/sessions/:sid",
    async (req, reply) => {
      const sid = requireSession(req, reply, deps.workspaces);
      if (!sid) return;
      const state = deps.orchestrator.getState(sid);
      const artifacts = await deps.artifacts.list(sid);
      reply.send({ state, artifacts });
    },
  );

  app.delete<{ Params: { sid: string } }>(
    "/api/sessions/:sid",
    async (req, reply) => {
      const sid = req.params.sid;
      if (!isValidSessionId(sid)) {
        reply.code(400).send({ error: "invalid session id" });
        return;
      }
      const root = deps.workspaces.paths(sid).root;
      if (!existsSync(root)) {
        reply.code(404).send({ error: "session not found" });
        return;
      }
      // Close the per-session writer so the file handle is released before rm.
      await deps.eventLog.closeAll();
      await rm(root, { recursive: true, force: true });
      reply.code(204).send();
    },
  );
}
```

> Note on `closeAll` in DELETE: v1 simplification — closing every session's log handle on any delete is wasteful but trivially correct (the SessionEventLog re-attaches lazily next time anything subscribes). If multi-session traffic becomes hot, replace with a `close(sessionId)` method in a v2 refactor.

- [ ] **Step 6: Run the tests, verify pass**

Run: `pnpm vitest run apps/server/test/api/sessions-routes.test.ts`
Expected: PASS — 7 tests green.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/api apps/server/test/api/sessions-routes.test.ts
git commit -m "feat(server): createApp + /api/sessions CRUD (POST/GET/DELETE)"
```

---

## Task 8: Uploads route — POST /api/sessions/:sid/uploads

**Files:**
- Create: `apps/server/src/api/uploads-routes.ts`
- Modify: `apps/server/src/api/app.ts` (register uploads routes)
- Create: `apps/server/test/api/uploads-routes.test.ts`

The route accepts `multipart/form-data` with one or more files under any field names, saves them via `WorkspaceManager.saveUpload`, and returns the workspace-relative paths so the client can reference them in a later `POST /messages` body.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/test/api/uploads-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import FormData from "form-data";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { createApp, type AppDeps } from "../../src/api/app.js";

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let sessionId: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-upload-route-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(workspaces, events);
  const phases = new PhaseRegistry();
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts, phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(),
  });
  const eventLog = new SessionEventLog({ events, workspaces });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog };
  app = await createApp(deps);
  sessionId = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

function multipartInject(files: Array<{ filename: string; content: Buffer; contentType: string }>) {
  const form = new FormData();
  for (const f of files) form.append("file", f.content, { filename: f.filename, contentType: f.contentType });
  return { payload: form.getBuffer(), headers: form.getHeaders() };
}

describe("uploads route", () => {
  it("POST /api/sessions/:sid/uploads saves one file and returns its relative path", async () => {
    const { payload, headers } = multipartInject([
      { filename: "logo.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/uploads`,
      payload, headers,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { files: { name: string; path: string }[] };
    expect(body.files).toEqual([{ name: "logo.png", path: "uploads/logo.png" }]);
    const onDisk = readFileSync(join(root, sessionId, "uploads/logo.png"));
    expect(onDisk).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("POST /api/sessions/:sid/uploads handles multiple files in one request", async () => {
    const { payload, headers } = multipartInject([
      { filename: "a.png", content: Buffer.from("a"), contentType: "image/png" },
      { filename: "b.png", content: Buffer.from("b"), contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/uploads`,
      payload, headers,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { files: { name: string; path: string }[] };
    expect(body.files.map((f) => f.name).sort()).toEqual(["a.png", "b.png"]);
    expect(existsSync(join(root, sessionId, "uploads/a.png"))).toBe(true);
    expect(existsSync(join(root, sessionId, "uploads/b.png"))).toBe(true);
  });

  it("POST /api/sessions/:sid/uploads rejects a disallowed extension with 400", async () => {
    const { payload, headers } = multipartInject([
      { filename: "evil.exe", content: Buffer.from("x"), contentType: "application/octet-stream" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/uploads`,
      payload, headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/sessions/:sid/uploads is 404 for an unknown session", async () => {
    const { payload, headers } = multipartInject([
      { filename: "a.png", content: Buffer.from("a"), contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/nope/uploads`,
      payload, headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /api/sessions/:sid/uploads with no files returns 400", async () => {
    const { payload, headers } = multipartInject([]);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/uploads`,
      payload, headers,
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/server/test/api/uploads-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

```ts
// apps/server/src/api/uploads-routes.ts
import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { requireSession } from "./route-helpers.js";

export async function registerUploadsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post<{ Params: { sid: string } }>(
    "/api/sessions/:sid/uploads",
    async (req, reply) => {
      const sid = requireSession(req, reply, deps.workspaces);
      if (!sid) return;
      const saved: { name: string; path: string }[] = [];
      try {
        for await (const part of req.parts()) {
          if (part.type !== "file") continue;
          const buf = await part.toBuffer();
          const name = basename(part.filename ?? "upload.bin");
          await deps.workspaces.saveUpload(sid, name, buf);
          saved.push({ name, path: `uploads/${name}` });
        }
      } catch (err) {
        reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (saved.length === 0) {
        reply.code(400).send({ error: "no files in upload" });
        return;
      }
      reply.code(201).send({ files: saved });
    },
  );
}
```

- [ ] **Step 4: Wire it into `createApp`**

In `apps/server/src/api/app.ts` add the import and register call:

```ts
import { registerUploadsRoutes } from "./uploads-routes.js";
// …after registerSessionsRoutes:
await registerUploadsRoutes(app, deps);
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm vitest run apps/server/test/api/uploads-routes.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/api/uploads-routes.ts apps/server/src/api/app.ts apps/server/test/api/uploads-routes.test.ts
git commit -m "feat(server): POST /api/sessions/:sid/uploads (multipart, workspace-rooted)"
```

---

## Task 9: Messages route — POST /api/sessions/:sid/messages

**Files:**
- Create: `apps/server/src/api/messages-routes.ts`
- Modify: `apps/server/src/api/app.ts`
- Create: `apps/server/test/api/messages-routes.test.ts`

This is a fire-and-forget endpoint: validate the body against `UserMessageSchema`, call `orchestrator.handleMessage(sid, msg)` *without* awaiting it (so the HTTP response returns immediately even though the phase pipeline runs for many seconds), and return `202 Accepted` with the current state snapshot. Errors inside the orchestrator surface via SSE — not via this response.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/test/api/messages-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { FakePhaseHandler } from "../../src/phases/fake-handler.js";
import { createApp, type AppDeps } from "../../src/api/app.js";
import type { PhaseId } from "@ultracreator/shared";

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let sessionId: string;

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};
const designData = {
  mood: "energetic", palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades", keyVisuals: [], sampleFrames: [],
};
const scriptData = {
  totalSec: 30,
  scenes: [{ id: "s1", startSec: 0, durationSec: 30, visual: "logo" }],
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-msg-route-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(workspaces, events);
  const phases = new PhaseRegistry();
  const handlers = new Map<PhaseId, FakePhaseHandler>([
    ["research", new FakePhaseHandler({ phase: "research", produce: async () => [{ kind: "brief", data: briefData }] })],
    ["design",   new FakePhaseHandler({ phase: "design",   produce: async () => [{ kind: "design", data: designData }] })],
    ["script",   new FakePhaseHandler({ phase: "script",   produce: async () => [{ kind: "script", data: scriptData }] })],
    ["render",   new FakePhaseHandler({ phase: "render",   produce: async (ctx) => [
      { kind: "composition", data: { dir: "composition", entry: "index.html" } },
      { kind: "mp4", data: { path: join(ctx.workspaces.paths(ctx.sessionId).output, "out.mp4") } },
    ]})],
  ]);
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts, phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers,
  });
  const eventLog = new SessionEventLog({ events, workspaces });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog };
  app = await createApp(deps);
  sessionId = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

async function waitForGate(sid: string, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const state = deps.orchestrator.getState(sid);
    if (state.kind === "awaiting-gate") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`gate not reached, last state: ${JSON.stringify(deps.orchestrator.getState(sid))}`);
}

describe("messages route", () => {
  it("POST /api/sessions/:sid/messages with constraints kicks off the pipeline (gates at design)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: {
        text: "make me a promo",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    await waitForGate(sessionId);
    const state = deps.orchestrator.getState(sessionId);
    expect(state).toEqual({ kind: "awaiting-gate", phase: "design" });
  });

  it("POST /api/sessions/:sid/messages with /approve advances past a gate", async () => {
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: {
        text: "go",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      },
    });
    await waitForGate(sessionId);
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: "/approve" },
    });
    // After approve, the orchestrator should reach the SCRIPT gate.
    await waitForGate(sessionId);
    expect(deps.orchestrator.getState(sessionId)).toEqual({ kind: "awaiting-gate", phase: "script" });
  });

  it("POST /api/sessions/:sid/messages with /abort flips state out of running", async () => {
    // Replace research with a slow handler we can interrupt.
    deps.orchestrator = new SessionOrchestrator({
      workspaces: deps.workspaces,
      events: deps.events,
      artifacts: deps.artifacts,
      phases: deps.phases,
      intentRouter: new RuleBasedIntentRouter(),
      handlers: new Map([
        ["research", new FakePhaseHandler({
          phase: "research",
          produce: async (ctx) => {
            await new Promise((resolve, reject) => {
              const t = setTimeout(resolve, 5000);
              ctx.signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("Aborted")); });
            });
            return [{ kind: "brief", data: briefData }];
          },
        })],
      ]),
    });
    await app.close();
    app = await createApp(deps);
    sessionId = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;

    void app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: {
        text: "go",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      },
    });
    // wait for "running"
    const start = Date.now();
    while (Date.now() - start < 500 && deps.orchestrator.getState(sessionId).kind !== "running") {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(deps.orchestrator.getState(sessionId).kind).toBe("running");
    const abort = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: "/abort" },
    });
    expect(abort.statusCode).toBe(202);
    // wait for error state
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && deps.orchestrator.getState(sessionId).kind === "running") {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(deps.orchestrator.getState(sessionId).kind).toBe("error");
  });

  it("POST /api/sessions/:sid/messages rejects body that does not match UserMessageSchema (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 123 }, // wrong type
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/sessions/:sid/messages is 404 for an unknown session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/nope/messages",
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/server/test/api/messages-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

```ts
// apps/server/src/api/messages-routes.ts
import type { FastifyInstance } from "fastify";
import { UserMessageSchema } from "@ultracreator/shared";
import type { AppDeps } from "./app.js";
import { requireSession } from "./route-helpers.js";

export async function registerMessagesRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post<{ Params: { sid: string } }>(
    "/api/sessions/:sid/messages",
    async (req, reply) => {
      const sid = requireSession(req, reply, deps.workspaces);
      if (!sid) return;
      const message = UserMessageSchema.parse(req.body);
      // Fire and forget — the pipeline is long-running and the client
      // observes progress via SSE, not via this response.
      void deps.orchestrator.handleMessage(sid, message).catch((err) => {
        app.log.error({ err, sid }, "orchestrator.handleMessage rejected");
      });
      reply.code(202).send({ accepted: true });
    },
  );
}
```

- [ ] **Step 4: Wire into `createApp`**

```ts
// apps/server/src/api/app.ts
import { registerMessagesRoutes } from "./messages-routes.js";
// …
await registerMessagesRoutes(app, deps);
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm vitest run apps/server/test/api/messages-routes.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/api/messages-routes.ts apps/server/src/api/app.ts apps/server/test/api/messages-routes.test.ts
git commit -m "feat(server): POST /api/sessions/:sid/messages — fire-and-forget orchestrator handoff"
```

---

## Task 10: Artifacts routes — list + get envelope

**Files:**
- Create: `apps/server/src/api/artifacts-routes.ts`
- Modify: `apps/server/src/api/app.ts`
- Create: `apps/server/test/api/artifacts-routes.test.ts`

Two endpoints:
- `GET /api/sessions/:sid/artifacts` → `ArtifactDescriptor[]`
- `GET /api/sessions/:sid/artifacts/:kind` → latest `ArtifactEnvelope` of that kind (404 if none); `?version=N` for a specific version.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/test/api/artifacts-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { createApp, type AppDeps } from "../../src/api/app.js";

const brief = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9" as const, withVoiceover: false },
};

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let sessionId: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-art-route-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(workspaces, events);
  const phases = new PhaseRegistry();
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts, phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(),
  });
  const eventLog = new SessionEventLog({ events, workspaces });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog };
  app = await createApp(deps);
  sessionId = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("artifacts routes", () => {
  it("GET /api/sessions/:sid/artifacts lists descriptors in write order", async () => {
    await deps.artifacts.put(sessionId, "brief", brief);
    await deps.artifacts.put(sessionId, "brief", { ...brief, audience: "ops" });
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/artifacts` });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ kind: string; version: number }>;
    expect(list.map((d) => ({ kind: d.kind, version: d.version }))).toEqual([
      { kind: "brief", version: 1 },
      { kind: "brief", version: 2 },
    ]);
  });

  it("GET /api/sessions/:sid/artifacts/:kind returns the latest envelope", async () => {
    await deps.artifacts.put(sessionId, "brief", brief);
    await deps.artifacts.put(sessionId, "brief", { ...brief, audience: "ops" });
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/artifacts/brief` });
    expect(res.statusCode).toBe(200);
    const env = res.json() as { version: number; data: { audience: string } };
    expect(env.version).toBe(2);
    expect(env.data.audience).toBe("ops");
  });

  it("GET /api/sessions/:sid/artifacts/:kind?version=N returns that specific version", async () => {
    await deps.artifacts.put(sessionId, "brief", brief);
    await deps.artifacts.put(sessionId, "brief", { ...brief, audience: "ops" });
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/artifacts/brief?version=1` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { version: number }).version).toBe(1);
  });

  it("GET /api/sessions/:sid/artifacts/:kind is 404 when no version exists", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/artifacts/brief` });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/sessions/:sid/artifacts/:kind is 400 for an unknown kind", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/artifacts/bogus` });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/sessions/:sid/artifacts is 404 for an unknown session", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/nope/artifacts` });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/server/test/api/artifacts-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

```ts
// apps/server/src/api/artifacts-routes.ts
import type { FastifyInstance } from "fastify";
import { ArtifactKindSchema } from "@ultracreator/shared";
import type { AppDeps } from "./app.js";
import { requireSession } from "./route-helpers.js";

export async function registerArtifactsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<{ Params: { sid: string } }>(
    "/api/sessions/:sid/artifacts",
    async (req, reply) => {
      const sid = requireSession(req, reply, deps.workspaces);
      if (!sid) return;
      const list = await deps.artifacts.list(sid);
      reply.send(list);
    },
  );

  app.get<{ Params: { sid: string; kind: string }; Querystring: { version?: string } }>(
    "/api/sessions/:sid/artifacts/:kind",
    async (req, reply) => {
      const sid = requireSession(req, reply, deps.workspaces);
      if (!sid) return;
      const kindParse = ArtifactKindSchema.safeParse(req.params.kind);
      if (!kindParse.success) {
        reply.code(400).send({ error: "invalid artifact kind" });
        return;
      }
      const version = req.query.version !== undefined ? Number(req.query.version) : undefined;
      if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
        reply.code(400).send({ error: "version must be a positive integer" });
        return;
      }
      const env = await deps.artifacts.get(sid, kindParse.data, version);
      if (!env) {
        reply.code(404).send({ error: "artifact not found" });
        return;
      }
      reply.send(env);
    },
  );
}
```

- [ ] **Step 4: Wire into `createApp`**

```ts
// apps/server/src/api/app.ts
import { registerArtifactsRoutes } from "./artifacts-routes.js";
// …
await registerArtifactsRoutes(app, deps);
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm vitest run apps/server/test/api/artifacts-routes.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/api/artifacts-routes.ts apps/server/src/api/app.ts apps/server/test/api/artifacts-routes.test.ts
git commit -m "feat(server): GET /api/sessions/:sid/artifacts[/:kind] — list + envelope"
```

---

## Task 11: Files route — GET /api/sessions/:sid/files/* with Range support

**Files:**
- Create: `apps/server/src/api/files-routes.ts`
- Modify: `apps/server/src/api/app.ts`
- Create: `apps/server/test/api/files-routes.test.ts`

Serves any file under the session workspace (uploads, narration mp3, output mp4, composition assets). Path traversal is rejected. Browsers need `Range` support so `<video>` can seek.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/test/api/files-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { createApp, type AppDeps } from "../../src/api/app.js";

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let sessionId: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-files-route-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(workspaces, events);
  const phases = new PhaseRegistry();
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts, phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(),
  });
  const eventLog = new SessionEventLog({ events, workspaces });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog };
  app = await createApp(deps);
  sessionId = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("files route", () => {
  it("serves a full file with 200 and correct Content-Length when no Range header", async () => {
    const body = Buffer.from("hello world");
    writeFileSync(join(root, sessionId, "uploads/hi.txt"), body);
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/uploads/hi.txt`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe(String(body.byteLength));
    expect(res.rawPayload).toEqual(body);
  });

  it("serves a byte range with 206 and Content-Range when Range: bytes=2-6 is sent", async () => {
    const body = Buffer.from("hello world"); // 0..10
    writeFileSync(join(root, sessionId, "uploads/hi.txt"), body);
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/uploads/hi.txt`,
      headers: { Range: "bytes=2-6" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 2-6/${body.byteLength}`);
    expect(res.headers["content-length"]).toBe("5");
    expect(res.rawPayload).toEqual(Buffer.from("llo w"));
  });

  it("handles open-ended Range: bytes=4-", async () => {
    const body = Buffer.from("hello world");
    writeFileSync(join(root, sessionId, "uploads/hi.txt"), body);
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/uploads/hi.txt`,
      headers: { Range: "bytes=4-" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 4-10/${body.byteLength}`);
    expect(res.rawPayload).toEqual(Buffer.from("o world"));
  });

  it("returns 416 when the Range is unsatisfiable", async () => {
    const body = Buffer.from("hi");
    writeFileSync(join(root, sessionId, "uploads/hi.txt"), body);
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/uploads/hi.txt`,
      headers: { Range: "bytes=100-200" },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */2`);
  });

  it("rejects path traversal (../..) with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/../../etc/passwd`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 if the file does not exist inside the workspace", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/output/never.mp4`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("sets Content-Type=video/mp4 for .mp4 files", async () => {
    mkdirSync(join(root, sessionId, "output"), { recursive: true });
    writeFileSync(join(root, sessionId, "output/x.mp4"), Buffer.from("fake"));
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/output/x.mp4`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/server/test/api/files-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

```ts
// apps/server/src/api/files-routes.ts
import { createReadStream, statSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { requireSession } from "./route-helpers.js";

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
};

function mimeOf(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

interface ParsedRange {
  start: number;
  end: number; // inclusive
}

function parseRange(header: string, size: number): ParsedRange | "unsatisfiable" | null {
  const m = /^bytes=(\d+)?-(\d+)?$/.exec(header.trim());
  if (!m) return null;
  let start = m[1] !== undefined ? Number(m[1]) : NaN;
  let end = m[2] !== undefined ? Number(m[2]) : NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    // suffix range: -N → last N bytes
    const suffix = end;
    if (suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start > end || start >= size) return "unsatisfiable";
  if (end >= size) end = size - 1;
  return { start, end };
}

export async function registerFilesRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<{ Params: { sid: string; "*": string } }>(
    "/api/sessions/:sid/files/*",
    async (req, reply) => {
      const sid = requireSession(req, reply, deps.workspaces);
      if (!sid) return;
      const relative = req.params["*"];
      const root = deps.workspaces.paths(sid).root;
      const target = resolve(root, relative);
      if (!target.startsWith(resolve(root) + "/") && target !== resolve(root)) {
        reply.code(400).send({ error: "path escapes workspace" });
        return;
      }
      if (!existsSync(target)) {
        reply.code(404).send({ error: "file not found" });
        return;
      }
      const stat = statSync(target);
      if (!stat.isFile()) {
        reply.code(404).send({ error: "not a file" });
        return;
      }

      const rangeHeader = req.headers.range;
      const contentType = mimeOf(target);
      reply.header("Accept-Ranges", "bytes");
      reply.header("Content-Type", contentType);

      if (rangeHeader) {
        const range = parseRange(rangeHeader, stat.size);
        if (range === "unsatisfiable") {
          reply.code(416).header("Content-Range", `bytes */${stat.size}`).send();
          return;
        }
        if (range !== null) {
          const length = range.end - range.start + 1;
          reply.code(206);
          reply.header("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
          reply.header("Content-Length", String(length));
          return reply.send(createReadStream(target, { start: range.start, end: range.end }));
        }
      }

      reply.header("Content-Length", String(stat.size));
      return reply.send(createReadStream(target));
    },
  );
}
```

- [ ] **Step 4: Wire into `createApp`**

```ts
// apps/server/src/api/app.ts
import { registerFilesRoutes } from "./files-routes.js";
// …
await registerFilesRoutes(app, deps);
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm vitest run apps/server/test/api/files-routes.test.ts`
Expected: PASS — 7 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/api/files-routes.ts apps/server/src/api/app.ts apps/server/test/api/files-routes.test.ts
git commit -m "feat(server): GET /api/sessions/:sid/files/* with Range / 206 / traversal guard"
```

---

## Task 12: Stream route — GET /api/sessions/:sid/stream (SSE with reconnect)

**Files:**
- Create: `apps/server/src/api/stream-routes.ts`
- Modify: `apps/server/src/api/app.ts`
- Create: `apps/server/test/api/stream-routes.test.ts`

The hardest route in the plan. Flow per request:

1. Validate session.
2. Determine `sinceSeq`: `Last-Event-Id` header (or `?lastEventId=` query for `EventSource` clients that can't set headers on first connect).
3. Send SSE headers, flush.
4. Subscribe to `eventLog`: buffer-mode initially (capture every live event in an array).
5. Replay from disk via `eventLog.readSince(sid, sinceSeq)` — write each frame, update `lastSent`.
6. Atomically: drain the buffered live events whose `seq > lastSent`, then flip the listener into write-through mode (no more buffering). Because nothing awaits between drain and flip, no callback can fire in between.
7. Heartbeat every 15s (configurable). Stop on client disconnect: unsubscribe + clear interval.

We test against a real Fastify `listen({ port: 0 })` and `fetch` with `AbortController`. Vitest can do this; we just need to be disciplined about closing on each test.

- [ ] **Step 1: Write the failing tests**

```ts
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
import { createApp, type AppDeps } from "../../src/api/app.js";
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
      else if (field === "data") current.data = (current.data ?? "") + val;
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
  const artifacts = new ArtifactStore(workspaces, events);
  const phases = new PhaseRegistry();
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts, phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(),
  });
  const eventLog = new SessionEventLog({ events, workspaces });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog };
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
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/server/test/api/stream-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the stream route**

```ts
// apps/server/src/api/stream-routes.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "./app.js";
import { requireSession } from "./route-helpers.js";
import { sseHeaders, writeSseFrame, writeSseHeartbeat } from "./sse-writer.js";
import type { SequencedEvent } from "../events/session-event-log.js";

export interface StreamRoutesOptions {
  heartbeatMs?: number;
}

export async function registerStreamRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  opts: StreamRoutesOptions = {},
): Promise<void> {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  app.get<{ Params: { sid: string }; Querystring: { lastEventId?: string } }>(
    "/api/sessions/:sid/stream",
    async (req, reply) => {
      const sid = requireSession(req, reply, deps.workspaces);
      if (!sid) return;

      const sinceSeq = parseSince(req);
      await deps.eventLog.attach(sid);

      // Take over the raw response.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, sseHeaders());

      const sink = { write: (chunk: string) => raw.write(chunk) };

      // Subscribe first; capture into a buffer until cutover.
      let lastSent = sinceSeq;
      let mode: "buffer" | "live" = "buffer";
      const buffered: SequencedEvent[] = [];
      const unsubscribe = deps.eventLog.subscribe(sid, (entry) => {
        if (mode === "buffer") buffered.push(entry);
        else if (entry.seq > lastSent) {
          writeSseFrame(sink, entry);
          lastSent = entry.seq;
        }
      });

      const heartbeat = setInterval(() => writeSseHeartbeat(sink), heartbeatMs);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };

      req.raw.on("close", cleanup);

      try {
        // Replay from disk.
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
        raw.end();
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
```

> Note: `mode = 'live'` flip + buffer drain are both synchronous Node operations within one tick of the event loop; no `await` separates them. Any listener callback queued by `EventBus.emit` runs to completion before the next emit can begin (the bus iterates a snapshot — see Plan 1's EventBus tests), so by the time the drain loop runs, every live event already either landed in `buffered` (will be drained) or is still synchronously running in the callback (will go through the `mode==='live'` write path). No event can be lost or duplicated unless `lastSent` is mishandled — and the `entry.seq > lastSent` guard belt-and-braces against duplicates.

- [ ] **Step 4: Wire into `createApp`**

```ts
// apps/server/src/api/app.ts
import { registerStreamRoutes } from "./stream-routes.js";
// …
await registerStreamRoutes(app, deps);
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm vitest run apps/server/test/api/stream-routes.test.ts`
Expected: PASS — 6 tests green.

If "drops nothing during cutover" flakes (it loops emitting 20 events; sub-ms timing), the *first* place to look is whether `parseSseFrames` is correctly handling the partial-line case when many frames arrive in one chunk. Do not raise timeouts — fix the parser. The parser above keeps a residual `buf` across chunks and only emits a frame on a blank-line boundary, which is correct.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/api/stream-routes.ts apps/server/src/api/app.ts apps/server/test/api/stream-routes.test.ts
git commit -m "feat(server): SSE /api/sessions/:sid/stream with Last-Event-Id replay + race-free cutover"
```

---

## Task 13: Server bootstrap — `server.ts`

**Files:**
- Create: `apps/server/src/api/server.ts`

The bootstrap is the only file that actually instantiates the real model + TTS + fetch + render worker; tests never go through it.

- [ ] **Step 1: Write the bootstrap**

```ts
// apps/server/src/api/server.ts
import { createAnthropic } from "@earendil-works/pi-ai";
import { composeOrchestrator } from "../compose-orchestrator.js";
import { GeminiTTSProvider } from "../providers/gemini-tts.js";
import { SessionEventLog } from "../events/session-event-log.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";
const BASE_DIR = process.env.WORKSPACES_DIR ?? "./workspaces";
const ANTHROPIC_API_KEY = required("ANTHROPIC_API_KEY");
const GEMINI_API_KEY = required("GEMINI_API_KEY");

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const composed = composeOrchestrator({
  baseDir: BASE_DIR,
  model: createAnthropic({ apiKey: ANTHROPIC_API_KEY }).model("claude-opus-4-7"),
  fetch: globalThis.fetch,
  tts: new GeminiTTSProvider({ apiKey: GEMINI_API_KEY }),
});

const eventLog = new SessionEventLog({
  events: composed.events,
  workspaces: composed.workspaces,
});

const app = await createApp(
  { ...composed, eventLog },
  { logger: true },
);

await app.listen({ host: HOST, port: PORT });
console.log(`ultracreator-server listening on http://${HOST}:${PORT}`);

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, closing…`);
  await app.close();
  await eventLog.closeAll();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
```

> The exact `createAnthropic(...)` / `model(...)` shape comes from Plan 3 Task 3 (pi-ai). If that import path differs in the merged Plan 3, adjust the import here to match what Plan 3 actually exported — do not change the public Pi API. Same for `GeminiTTSProvider` — Plan 3 Task 13 named the export.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: passes. If `createAnthropic` import fails to resolve, open `apps/server/src/compose-orchestrator.ts` and copy the exact same import shape (it already constructs a model via this same SDK).

- [ ] **Step 3: Smoke test — boot, hit health, kill**

```bash
WORKSPACES_DIR=$(mktemp -d) \
ANTHROPIC_API_KEY=dummy GEMINI_API_KEY=dummy \
  pnpm -F @ultracreator/server start &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/sessions -X POST
kill $SERVER_PID
```
Expected: `201` printed; process exits cleanly.

(If the test machine doesn't have curl/network sandboxing, skip — Task 14's HTTP test exercises the same path through Fastify directly.)

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/api/server.ts
git commit -m "feat(server): server.ts bootstrap — composeOrchestrator + createApp + listen"
```

---

## Task 14: End-to-end HTTP happy-path test

**Files:**
- Create: `apps/server/test/api/end-to-end.test.ts`

One integration test that exercises the full HTTP surface against the orchestrator with fake handlers — creates a session, uploads a file, sends a message, watches SSE through the gates, approves twice, observes `render.done`. Proves all the routes interlock correctly without burning a token or rendering a real MP4.

- [ ] **Step 1: Write the test**

```ts
// apps/server/test/api/end-to-end.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import FormData from "form-data";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { FakePhaseHandler } from "../../src/phases/fake-handler.js";
import { createApp, type AppDeps } from "../../src/api/app.js";
import type { PhaseId } from "@ultracreator/shared";

const brief = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs", keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9" as const, withVoiceover: false },
};
const design = {
  mood: "energetic", palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades", keyVisuals: [], sampleFrames: [],
};
const script = { totalSec: 30, scenes: [{ id: "s1", startSec: 0, durationSec: 30, visual: "logo" }] };

async function pollUntil<T>(fn: () => Promise<T | null> | T | null, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("pollUntil timed out");
}

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let baseUrl: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-e2e-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(workspaces, events);
  const phases = new PhaseRegistry();
  const handlers = new Map<PhaseId, FakePhaseHandler>([
    ["research", new FakePhaseHandler({ phase: "research", produce: async () => [{ kind: "brief", data: brief }] })],
    ["design",   new FakePhaseHandler({ phase: "design",   produce: async () => [{ kind: "design", data: design }] })],
    ["script",   new FakePhaseHandler({ phase: "script",   produce: async () => [{ kind: "script", data: script }] })],
    ["render",   new FakePhaseHandler({ phase: "render",   produce: async (ctx) => {
      const out = join(ctx.workspaces.paths(ctx.sessionId).output, "out.mp4");
      writeFileSync(out, Buffer.from("FAKEMP4"));
      return [
        { kind: "composition", data: { dir: "composition", entry: "index.html" } },
        { kind: "mp4", data: { path: out } },
      ];
    }})],
  ]);
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts, phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers,
  });
  const eventLog = new SessionEventLog({ events, workspaces });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog };
  app = await createApp(deps);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("end-to-end HTTP happy path", () => {
  it("create session → upload → message → approve → approve → render.done → fetch mp4", async () => {
    // 1. Create session.
    const create = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
    expect(create.status).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    // 2. Upload a fake asset.
    const form = new FormData();
    form.append("file", Buffer.from("png-bytes"), { filename: "logo.png", contentType: "image/png" });
    const upload = await fetch(`${baseUrl}/api/sessions/${sessionId}/uploads`, {
      method: "POST",
      body: form.getBuffer(),
      headers: form.getHeaders(),
    });
    expect(upload.status).toBe(201);

    // 3. Kick off the pipeline.
    await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "build it",
        uploadedFiles: ["uploads/logo.png"],
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      }),
    });
    await pollUntil(async () => {
      const r = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
      const body = (await r.json()) as { state: { kind: string; phase?: string } };
      return body.state.kind === "awaiting-gate" && body.state.phase === "design" ? body : null;
    });

    // 4. Approve design.
    await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/approve" }),
    });
    await pollUntil(async () => {
      const r = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
      const body = (await r.json()) as { state: { kind: string; phase?: string } };
      return body.state.kind === "awaiting-gate" && body.state.phase === "script" ? body : null;
    });

    // 5. Approve script.
    await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/approve" }),
    });
    await pollUntil(async () => {
      const r = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
      const body = (await r.json()) as { state: { kind: string } };
      return body.state.kind === "done" ? body : null;
    });

    // 6. Fetch the produced MP4 via /files.
    const mp4 = await fetch(`${baseUrl}/api/sessions/${sessionId}/files/output/out.mp4`);
    expect(mp4.status).toBe(200);
    expect(mp4.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await mp4.arrayBuffer())).toEqual(new Uint8Array(Buffer.from("FAKEMP4")));

    // 7. The events.jsonl on disk has a complete trace.
    const list = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`)).json()) as Array<{ kind: string }>;
    expect(list.map((d) => d.kind).sort()).toEqual(["brief", "composition", "design", "mp4", "script"]);
  }, 10_000);
});
```

- [ ] **Step 2: Run, verify pass**

Run: `pnpm vitest run apps/server/test/api/end-to-end.test.ts`
Expected: PASS — 1 test, ~1–3s.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/api/end-to-end.test.ts
git commit -m "test(server): end-to-end HTTP happy path through createApp + fakes"
```

---

## Task 15: Full suite + typecheck green

**Files:** none (verification task)

- [ ] **Step 1: Run the full default suite**

Run: `pnpm test`
Expected: PASS. New / extended counts vs. Plan 4:
- `session-event-log.test.ts` — 8
- `sse-writer.test.ts` — 4
- `session-id.test.ts` — 4
- `sessions-routes.test.ts` — 7
- `uploads-routes.test.ts` — 5
- `messages-routes.test.ts` — 5
- `artifacts-routes.test.ts` — 6
- `files-routes.test.ts` — 7
- `stream-routes.test.ts` — 6
- `end-to-end.test.ts` — 1
All Plan 1 / 2 / 3 / 4 suites stay green; no test should have been touched outside `apps/server/test/api/`.

- [ ] **Step 2: Run the typechecker**

Run: `pnpm typecheck`
Expected: exits 0 across `@ultracreator/shared` and `@ultracreator/server`.

- [ ] **Step 3: Run the external suite — confirm no regression**

Run: `pnpm test:external`
Expected: PASS (Plan 4's `render.external.test.ts` — Plan 5 added no external tests).

- [ ] **Step 4: Final commit if anything changed**

```bash
git add -A
git commit -m "chore: plan 5 green (Fastify API + SSE + event log)" || echo "nothing to commit"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:**
  - §4 architecture diagram routes `/sessions /messages /upload /artifacts/* /stream/:sid` — Tasks 7 (sessions), 9 (messages), 8 (uploads), 10 (artifacts), 12 (stream). The "single Node process plus one forked render worker" invariant is preserved: `composeOrchestrator` builds the worker; `createApp` just wraps the result in HTTP.
  - §5 "Frontend holds only UI state; all business state changes happen on the backend and are pushed via SSE" — Task 12 implements SSE with reconnect-safe replay; Task 9 makes `/messages` fire-and-forget so the client only learns of state changes via SSE.
  - §7 schemas — Plan 1 already validates them; Task 9 calls `UserMessageSchema.parse` at the HTTP boundary so bad input never reaches the orchestrator. Task 10 returns full `ArtifactEnvelope`s (shape from Plan 1's `ArtifactEnvelope<T>` interface).
  - §8 "Same session in multiple browser tabs → SSE broadcasts; all tabs get the same events" — Task 12 (each connection independently subscribes to `SessionEventLog`, and the log re-broadcasts every event to every subscriber). The reconnect-with-`Last-Event-Id` flow makes refresh-and-resume work too.
  - §8 "Oversized/illegal upload" — Task 8 lets `WorkspaceManager.saveUpload` validate (Plan 1's checks for extension allow-list + size limit) and converts the throw to HTTP 400. `@fastify/multipart`'s `fileSize` limit is also set from `createApp` opts as a defense-in-depth.
  - §8 "DELETE /api/sessions/:id for manual cleanup" — Task 7.
  - §8 Observability: "SSE events double as the frontend progress feed and are persisted to `events.jsonl`" — Tasks 2–3 (`SessionEventLog` is the *only* writer of that file; one JSON line per event with `seq`, `at`, `event`).
  - §8 Observability: "Full agent transcript at `workspaces/<sid>/logs/<phase>.v<n>.jsonl`" — explicitly Plan 3's responsibility (the Pi handlers write transcripts). Plan 5 only owns `events.jsonl`.
- **Out of scope here (later plans / future):**
  - Frontend — Plan 6 consumes these routes via TanStack Query + a native `EventSource` (or a small SSE client that handles `Last-Event-Id`).
  - Auth / accounts — explicitly v1 non-goal per spec §2.
  - Workspace LRU cleanup — spec §8 calls out as v2; the `DELETE /api/sessions/:sid` route in Task 7 is the manual hook for now.
  - Per-phase agent transcripts (`logs/<phase>.v<n>.jsonl`) — Plan 3's PiHandlers persist these; the API doesn't expose them as routes in v1. Adding `GET /api/sessions/:sid/logs/:phase` is a one-task v2 follow-up if the UI ever needs an "agent trace" panel.
  - SSE backpressure / max-clients-per-session — current code lets each connection install its own listener; for v1 with a single user this is fine. If frontend opens dozens of `EventSource`s by accident, the broadcast cost is O(n) per event; cap at the route level in a v2.
  - HTTP/2 + push notifications — out of scope; plain HTTP/1.1 SSE is sufficient and works through every proxy that doesn't strip `text/event-stream`.
  - Inline `ws://` for streaming — SSE is enough; WebSocket gives no benefit for a server→client event feed.
  - "Render-superseded-but-kept" UX from Plan 4's self-review: not in scope. Plan 5's `/messages` `/abort` flow hard-kills via `AbortController`. Plan 6 can build an abort+restart button on top of these routes without an API change.
- **Type-consistency self-check:**
  - `AppDeps` extends the same five primitives `composeOrchestrator` returns (`workspaces`, `events`, `artifacts`, `phases`, `orchestrator`) plus `eventLog`. `providers` from `ComposedOrchestrator` is intentionally omitted — no route needs it. Task 13 (`server.ts`) builds `AppDeps` from `composeOrchestrator(...)` + a `new SessionEventLog(...)`.
  - `SequencedEvent.event` is `ServerEvent` from `@ultracreator/shared` — same source Plan 1–4 use. `SequencedEvent.seq` matches the SSE `id:` line so `Last-Event-Id` round-trips losslessly.
  - `UserMessageSchema` import in Task 9 resolves through `@ultracreator/shared`'s barrel (`packages/shared/src/index.ts` re-exports `message.ts`).
  - `ArtifactKindSchema` import in Task 10 is the same one `ArtifactStore.put` validates against — invalid kinds rejected at both the HTTP and storage layers.
  - `requireSession` is the only place HTTP code checks workspace existence; everywhere else routes trust the `sid` it returns. Keeps the 400/404 contract consistent.
- **Determinism:** every Plan 5 test runs against in-process Fastify (`inject` or `listen({ port: 0 })`) with fake handlers / no LLMs / no real render. No tokens, no network. The cutover-race test (Task 12 "drops nothing") is the only one that depends on event-loop ordering; it's deterministic in single-threaded Node — if it flakes, suspect the SSE parser (not the route).
- **Where to push if something surprises you:**
  - If `@fastify/multipart`'s iterator API differs from `req.parts()` in the actual installed version, swap to `req.file()` (single) / `req.files()` (iterator) — both are stable across v8 and v9. The shape returned (`type: 'file'`, `filename`, `toBuffer()`) is the same.
  - If `reply.hijack()` doesn't exist on the installed Fastify version (it does in v4 and v5), the equivalent is `reply.sent = true` + writing to `reply.raw`. The contract used here only requires that Fastify stop trying to serialize a body for us.
  - If `Last-Event-Id` doesn't come through the test fetch — `undici` does forward it, but some test runners shim `fetch`. If so, fall back to the `?lastEventId=` query param (Task 12 test 3 already covers that path).
  - If `pnpm typecheck` complains about `req.params["*"]` in Task 11 — Fastify's wildcard param key is sometimes typed as `'*'`; use the indexed access shown, and if TS still rejects, widen to `{ Params: Record<string, string> }`.
  - The `WorkspaceManager.SESSION_ID_PATTERN` comment in `session-id.ts` is a contract reminder — if Plan 1's pattern ever changes, update both. (UUID v4 trivially passes the current pattern.)
