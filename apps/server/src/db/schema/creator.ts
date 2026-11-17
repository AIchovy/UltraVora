// Business session table. Named creator_sessions to avoid clashing with
// better-auth's login-state `session` table. Timestamps use bare `timestamp`
// to match the auth tables' convention (single-instance, UTC).
import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
  bigserial,
  integer,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import type { ServerEvent, LineageRef, UserMessage } from "@ultracreator/shared";
import { user } from "./auth.js";

export const creatorSession = pgTable(
  "creator_sessions",
  {
    id: text("id").primaryKey(), // = sid (UUID string from POST /api/sessions)
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title"), // truncated first user message; null at creation
    // idle | running | awaiting-gate | error | done — mirrors SessionState.kind. text, not enum.
    status: text("status").notNull().default("idle"),
    currentPhase: text("current_phase"), // PhaseId | null
    error: text("error"), // error string when in error state | null
    // Per-session execution mode: when true the orchestrator skips the
    // design/script user-approve gates and runs straight to render.
    autoApprove: boolean("auto_approve").notNull().default(false),
    // Billing run counter: 0 for the initial generation, +1 per user-initiated
    // re-run (refine at a gate / adjustment after done / revise-back /
    // update-brief). Participates in the credit-debit idempotency key so
    // adjustment runs charge while crash/top-up resumes of the SAME run dedup.
    runSeq: integer("run_seq").notNull().default(0),
    // The user's refinement text while parked in awaiting-credits, so a top-up
    // resume still applies the requested change instead of re-running verbatim.
    pendingRefinement: text("pending_refinement"),
    // Product Plaza: publicity + denormalised like counter + outbound product
    // link. A "public video" is is_public=true AND status='done'. free_grant
    // marks the ONE session that consumed the account's free public generation.
    isPublic: boolean("is_public").notNull().default(false),
    productUrl: text("product_url"), // outbound link; null when none entered
    freeGrant: boolean("free_grant").notNull().default(false),
    likeCount: integer("like_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    userUpdatedIdx: index("creator_sessions_user_id_updated_at_idx").on(t.userId, t.updatedAt),
    publicCreatedIdx: index("creator_sessions_public_created_at_idx").on(t.isPublic, t.createdAt),
    publicLikesIdx: index("creator_sessions_public_like_count_idx").on(t.isPublic, t.likeCount),
  }),
);

// Replaces workspaces/<sid>/logs/events.jsonl. One row per ServerEvent, stamped
// with a per-session monotonic seq (allocated in memory by SessionEventLog) and
// an ISO instant. SSE replay reads `seq > Last-Event-Id` ordered by seq.
export const sessionEvent = pgTable(
  "session_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => creatorSession.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: timestamp("at").notNull(),
    event: jsonb("event").$type<ServerEvent>().notNull(),
  },
  (t) => ({
    sessionSeqKey: uniqueIndex("session_events_session_id_seq_key").on(t.sessionId, t.seq),
  }),
);

// Replaces workspaces/<sid>/artifacts/*.json + index.json. Media files (mp4,
// audio, composition dir) stay on disk; `data` jsonb holds the descriptor with
// workspace-relative paths inside it.
export const artifact = pgTable(
  "artifacts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => creatorSession.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // ArtifactKind
    version: integer("version").notNull(),
    data: jsonb("data").notNull(),
    derivedFrom: jsonb("derived_from").$type<LineageRef[] | null>(), // nullable
    stale: boolean("stale").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    kindVersionKey: uniqueIndex("artifacts_session_id_kind_version_key").on(
      t.sessionId,
      t.kind,
      t.version,
    ),
  }),
);

// Durable message queue (spec §2/§4) — the recovery unit after a crash. One row
// per accepted user message; status advances pending → processing → done|error
// as SessionOrchestrator works through it. Startup recovery re-enqueues every
// pending|processing row. Abort keyword messages are intentionally NOT stored
// (control signal, not a work item). No error-detail column by design — the
// failure text lives on creator_sessions.error.
export const sessionMessage = pgTable(
  "session_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => creatorSession.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<UserMessage>().notNull(),
    status: text("status").notNull().default("pending"), // pending | processing | done | error
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (t) => ({
    // Startup recovery scans WHERE status IN ('pending','processing').
    statusIdx: index("session_messages_status_idx").on(t.status),
  }),
);

// One row per (user, public video) like. The unique index enforces the
// one-like-per-user-per-video rule; creator_sessions.like_count is the
// denormalised counter kept in step with inserts/deletes here.
export const videoLike = pgTable(
  "video_likes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => creatorSession.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    sessionUserKey: uniqueIndex("video_likes_session_id_user_id_key").on(t.sessionId, t.userId),
  }),
);
