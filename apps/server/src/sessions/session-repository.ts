import type { PhaseId, SessionStatus } from "@ultracreator/shared";

export type { SessionStatus };

export interface SessionRecord {
  id: string;
  userId: string;
  title: string | null;
  status: SessionStatus;
  currentPhase: PhaseId | null;
  error: string | null;
  /** When true, the orchestrator auto-passes the design/script gates. */
  autoApprove: boolean;
  /**
   * Billing run counter: 0 for the initial generation, incremented per
   * user-initiated re-run. Part of the credit-debit idempotency key.
   */
  runSeq: number;
  /** Refinement text preserved while parked in awaiting-credits, else null. */
  pendingRefinement: string | null;
  /** Product Plaza publicity (set at creation, immutable in v1). */
  isPublic: boolean;
  /** Outbound product link, or null. */
  productUrl: string | null;
  /** True when this session consumed the account's one free public grant. */
  freeGrant: boolean;
  /** Denormalised like counter. */
  likeCount: number;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface SessionStatusUpdate {
  status: SessionStatus;
  currentPhase: PhaseId | null;
  error: string | null;
  /**
   * Set while status is awaiting-credits and the parked run carries a user
   * refinement. Absent counts as null — every status write clears it unless
   * the caller explicitly parks one.
   */
  pendingRefinement?: string | null;
}

/**
 * Persistence for session ownership and status. The creator_sessions row is the
 * single source of truth for whether a session exists. Contract: `updateStatus`
 * is a plain UPDATE (no-op if the row is absent); rows are only created by
 * `create` (which carries the userId). The PG impl and the in-memory fake MUST
 * behave identically.
 */
export interface SessionRepository {
  create(input: {
    id: string;
    userId: string;
    autoApprove?: boolean;
    isPublic?: boolean;
    productUrl?: string | null;
  }): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  /** The user's sessions, ordered by updatedAt descending. */
  listByUser(userId: string): Promise<SessionRecord[]>;
  /** Plain UPDATE; silent no-op if the row is absent. Refreshes updatedAt to now. */
  updateStatus(id: string, update: SessionStatusUpdate): Promise<void>;
  /** Sets title only when it is currently null (first message names the session). */
  setTitleIfEmpty(id: string, title: string): Promise<void>;
  /** Plain UPDATE of the auto-approve flag; silent no-op if the row is absent. */
  setAutoApprove(id: string, value: boolean): Promise<void>;
  /**
   * Atomically bump the billing run counter and return the new value (0 when
   * the row is absent — orchestrator-only unit tests run without rows).
   */
  incrementRunSeq(id: string): Promise<number>;
  delete(id: string): Promise<void>;
  /**
   * Claim the account's one-time free public generation for this session.
   * Returns true when `sessionId` holds the grant afterwards — either it just
   * claimed it (no other session of `userId` had it) or it already held it
   * (idempotent). Returns false when another session already holds it.
   */
  claimFreePublicGrant(sessionId: string, userId: string): Promise<boolean>;
  /** True when any of the user's sessions already holds the free public grant. */
  hasFreePublicGrant(userId: string): Promise<boolean>;
}
