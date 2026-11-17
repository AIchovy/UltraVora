// End-to-end restart recovery against real PostgreSQL — the PG twin of
// restart-recovery.test.ts. Same scenario (orchestrator #1 hangs mid-design and
// is abandoned; orchestrator #2 over the same durable layer recover()s the run),
// but the durable layer is PgMessageStore/PgSessionRepository/PgArtifactRepository
// over ultracreator_test, so the test exercises the real markProcessing/
// listIncomplete/updateStatus SQL the fakes only imitate.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Brief, PhaseId, ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { PgArtifactRepository } from "../src/artifacts/pg-artifact-repository.js";
import { PhaseRegistry } from "../src/phases/registry.js";
import { FakePhaseHandler } from "../src/phases/fake-handler.js";
import type { PhaseHandler } from "../src/phases/types.js";
import { RuleBasedIntentRouter } from "../src/intent/intent-router.js";
import { SessionOrchestrator } from "../src/orchestrator/session-orchestrator.js";
import { PgSessionRepository } from "../src/sessions/pg-session-repository.js";
import { PgMessageStore } from "../src/messages/pg-message-store.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
// Shares ultracreator_test with the other *.pg.test.ts files — safe because the
// "pg" vitest project (vitest.suites.ts) runs them single-fork, one at a time.
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

const testDbName = new URL(TEST_URL).pathname.slice(1);
if (!testDbName.endsWith("_test") || !/^[a-z0-9_]+$/.test(testDbName)) {
  throw new Error(`Refusing destructive test against "${testDbName}"`);
}

let pool: pg.Pool;
let sessions: PgSessionRepository;
let messages: PgMessageStore;
let artifactRepo: PgArtifactRepository;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${testDbName}`).catch((e: { code?: string }) => {
    if (e.code !== "42P04") throw e;
  });
  await admin.end();
  pool = new pg.Pool({ connectionString: TEST_URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE;");
  await migrate(drizzle(pool), { migrationsFolder });
  sessions = new PgSessionRepository(drizzle(pool));
  messages = new PgMessageStore(drizzle(pool));
  artifactRepo = new PgArtifactRepository(drizzle(pool));
});

afterAll(async () => { await pool?.end(); });

let root: string;
beforeEach(async () => {
  await pool.query('TRUNCATE session_messages, artifacts, creator_sessions, "user" CASCADE');
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','U1','u1@x.com',false,now(),now())`,
  );
  root = mkdtempSync(join(tmpdir(), "uc-restart-pg-"));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const brief: Brief = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};
const designData = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades",
  keyVisuals: [],
  sampleFrames: [],
};

async function messageStatuses(): Promise<string[]> {
  const res = await pool.query("SELECT status FROM session_messages ORDER BY id");
  return res.rows.map((r: { status: string }) => r.status);
}

describe("restart recovery over PostgreSQL", () => {
  it("a task killed mid-design resumes from design (not research) on the next process", async () => {
    await sessions.create({ id: "s1", userId: "u1" });

    // ---- process #1: research completes, design hangs forever ----------------
    let signalDesignStarted!: () => void;
    const designStarted = new Promise<void>((r) => { signalDesignStarted = r; });
    const hangingDesign: PhaseHandler = {
      phase: "design" as const,
      async *run() {
        signalDesignStarted();
        await new Promise<never>(() => {}); // parked forever — the "kill" abandons it
      },
    };
    const events1 = new EventBus();
    const orch1 = new SessionOrchestrator({
      workspaces: new WorkspaceManager(root),
      events: events1,
      artifacts: new ArtifactStore(artifactRepo, events1),
      phases: new PhaseRegistry(),
      intentRouter: new RuleBasedIntentRouter(),
      handlers: new Map<PhaseId, PhaseHandler>([
        ["research", new FakePhaseHandler({ phase: "research", produce: async () => [{ kind: "brief", data: brief }] })],
        ["design", hangingDesign],
      ]),
      sessions,
      messages,
    });

    // Research parks at its asset-curation gate; approve it so the session is
    // actually IN design when the "kill" happens.
    await orch1.handleMessage("s1", {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(orch1.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "research" });
    // Fire and abandon — the returned promise never settles (design hangs).
    void orch1.handleMessage("s1", { text: "approve" });
    await designStarted;

    // Durable snapshot at "kill" time, read back from real PG rows: new-project
    // message done (parked at the research gate), approve message processing,
    // session running:design, research's brief already persisted.
    expect(await messageStatuses()).toEqual(["done", "processing"]);
    expect(await sessions.get("s1")).toMatchObject({ status: "running", currentPhase: "design" });
    expect(await artifactRepo.getLatest("s1", "brief")).not.toBeNull();

    // ---- process #2: fresh instance over the same database -------------------
    let researchRuns2 = 0;
    const events2 = new EventBus();
    const seen2: ServerEvent[] = [];
    events2.subscribe("s1", (e) => seen2.push(e));
    const orch2 = new SessionOrchestrator({
      workspaces: new WorkspaceManager(root),
      events: events2,
      artifacts: new ArtifactStore(artifactRepo, events2),
      phases: new PhaseRegistry(),
      intentRouter: new RuleBasedIntentRouter(),
      handlers: new Map<PhaseId, PhaseHandler>([
        ["research", new FakePhaseHandler({ phase: "research", produce: async () => { researchRuns2++; return [{ kind: "brief", data: brief }]; } })],
        ["design", new FakePhaseHandler({ phase: "design", produce: async () => [{ kind: "design", data: designData }] })],
      ]),
      sessions,
      messages,
    });

    await orch2.recover();
    await vi.waitFor(async () => expect(await messageStatuses()).toEqual(["done", "done"]));

    // Resumed from design: research did NOT re-run, design completed and gated.
    expect(researchRuns2).toBe(0);
    expect(seen2.filter((e) => e.type === "phase.started").map((e) => (e as { phase: string }).phase)).toEqual(["design"]);
    expect(orch2.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
    expect(await sessions.get("s1")).toMatchObject({ status: "awaiting-gate", currentPhase: "design" });
    expect(await artifactRepo.getLatest("s1", "design")).toMatchObject({ version: 1 });
    // The recovered run emits ordinary events — the SSE/frontend path needs nothing special.
    expect(seen2.some((e) => e.type === "gate.awaiting")).toBe(true);
  });
});
