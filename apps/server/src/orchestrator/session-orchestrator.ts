import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserMessageSchema, phaseCredits, FIRST_PHASE } from "@ultracreator/shared";
import type {
  Brief,
  PhaseCreditContext,
  PhaseId,
  UserMessage,
} from "@ultracreator/shared";
import type { CreditRepository, DebitResult } from "../credits/credit-repository.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { EventBus } from "../events/event-bus.js";
import type { MessageStore } from "../messages/message-store.js";
import type { SessionRepository, SessionStatus, SessionStatusUpdate } from "../sessions/session-repository.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import { isAbortText } from "../intent/intent-router.js";
import type { IntentRouter, RouterState } from "../intent/intent-router.js";
import type { PhaseHandler, PhaseContext } from "../phases/types.js";
import type { PhaseRegistry } from "../phases/registry.js";
import { describeError } from "../errors.js";
import { SessionQueue } from "./session-queue.js";
import { markStaleDownstream } from "./stale.js";
import type { SessionState } from "./state.js";

export type { SessionState } from "./state.js";

/** Where startNewProject persists the first user message inside the workspace. */
const INITIAL_MESSAGE_FILE = "initial-message.json";

/** Narrow slice of SessionMediaArchive the orchestrator depends on. */
export interface MediaRestorer {
  restoreMissing(sessionId: string): Promise<void>;
}

export interface OrchestratorDeps {
  workspaces: WorkspaceManager;
  events: EventBus;
  artifacts: ArtifactStore;
  phases: PhaseRegistry;
  intentRouter: IntentRouter;
  handlers: ReadonlyMap<PhaseId, PhaseHandler>;
  sessions: SessionRepository;
  messages: MessageStore;
  /** Optional: pulls archived media back to disk before a phase (re-)run. */
  media?: MediaRestorer;
  /**
   * Optional credit gating. When present, each phase is charged before it runs
   * and the session parks in `awaiting-credits` if the balance can't cover it.
   * Absent (e.g. in unit tests) → no gating, every phase runs free.
   */
  credits?: Pick<CreditRepository, "debit">;
}

function serializeStatus(state: SessionState): SessionStatusUpdate {
  switch (state.kind) {
    case "idle":
      return { status: "idle", currentPhase: null, error: null, pendingRefinement: null };
    case "running":
      return {
        status: "running",
        currentPhase: state.phase,
        error: null,
        pendingRefinement: state.refinement ?? null,
      };
    case "awaiting-gate":
      return { status: "awaiting-gate", currentPhase: state.phase, error: null, pendingRefinement: null };
    case "awaiting-credits":
      return {
        status: "awaiting-credits",
        currentPhase: state.phase,
        error: null,
        pendingRefinement: state.refinement ?? null,
      };
    case "error":
      return { status: "error", currentPhase: state.phase, error: state.error, pendingRefinement: null };
    case "done":
      return { status: "done", currentPhase: state.lastPhase, error: null, pendingRefinement: null };
  }
}

function deserializeStatus(row: {
  status: SessionStatus;
  currentPhase: PhaseId | null;
  error: string | null;
  pendingRefinement: string | null;
}): SessionState | null {
  switch (row.status) {
    case "idle":
      return null; // getState already defaults to idle; no need to occupy the map
    // A "running" row after a restart is resumed by recover() at startup: the
    // interrupted message is still `processing` in session_messages and gets
    // re-enqueued from current_phase.
    case "running":
      return row.currentPhase
        ? {
            kind: "running",
            phase: row.currentPhase,
            ...(row.pendingRefinement !== null ? { refinement: row.pendingRefinement } : {}),
          }
        : null;
    case "awaiting-gate":
      return row.currentPhase ? { kind: "awaiting-gate", phase: row.currentPhase } : null;
    case "awaiting-credits":
      return row.currentPhase
        ? {
            kind: "awaiting-credits",
            phase: row.currentPhase,
            ...(row.pendingRefinement !== null ? { refinement: row.pendingRefinement } : {}),
          }
        : null;
    case "error":
      return row.currentPhase ? { kind: "error", phase: row.currentPhase, error: row.error ?? "(unknown error)" } : null;
    case "done":
      return row.currentPhase ? { kind: "done", lastPhase: row.currentPhase } : null;
  }
}

export class SessionOrchestrator {
  private states = new Map<string, SessionState>();
  private queue = new SessionQueue();
  private controllers = new Map<string, AbortController>();
  private initialMessages = new Map<string, UserMessage>();
  private rehydrated = new Set<string>();

  constructor(private deps: OrchestratorDeps) {}

  getState(sessionId: string): SessionState {
    return this.states.get(sessionId) ?? { kind: "idle" };
  }

  /**
   * The session's status from the durable row, rehydrating the in-memory state
   * if this process hasn't touched the session yet (e.g. after a restart). The
   * REST GET uses this so a parked/errored run isn't misreported as `idle` just
   * because the in-memory map was reset.
   */
  async getPersistedState(sessionId: string): Promise<SessionState> {
    await this.rehydrateState(sessionId);
    return this.getState(sessionId);
  }

  /**
   * Release every per-session map entry for a deleted session. The durable row
   * and its cascade are already gone by the time the DELETE route calls this,
   * so there is nothing to persist — without this these entries would linger in
   * memory until the next process restart. Scoped to the common case (deleting
   * an idle/parked/done session): cancelling an in-flight run is not a goal —
   * the route rm's the workspace first, so a mid-run phase is already failing.
   */
  forget(sessionId: string): void {
    this.controllers.delete(sessionId);
    this.states.delete(sessionId);
    this.initialMessages.delete(sessionId);
    this.rehydrated.delete(sessionId);
    this.queue.forget(sessionId);
  }

  /**
   * Set in-memory state AND mirror it to the durable creator_sessions row, which
   * is the source of truth for recovery after a restart. updateStatus is a no-op
   * if the row was never created (e.g. orchestrator-only unit tests).
   */
  private async setState(sessionId: string, state: SessionState): Promise<void> {
    this.states.set(sessionId, state);
    await this.deps.sessions.updateStatus(sessionId, serializeStatus(state));
  }

  /**
   * After a process restart the in-memory state map is empty. Recover the
   * SessionState from the creator_sessions row (the durable source of truth),
   * so a session parked at an approval gate can still be approved/refined instead
   * of having `/approve` silently reclassified as a refine (or no-op) against `idle`.
   *
   * The initial message is still restored from the workspace file written by
   * startNewProject so a research re-run after a restart still has its input.
   */
  private async rehydrateState(sessionId: string): Promise<void> {
    if (this.states.has(sessionId) || this.rehydrated.has(sessionId)) return;
    this.rehydrated.add(sessionId);
    const row = await this.deps.sessions.get(sessionId);
    if (row) {
      const recovered = deserializeStatus(row);
      if (recovered) this.states.set(sessionId, recovered); // direct set: reading FROM the repo
    }
    // The initial message is still restored from the workspace file on disk.
    if (!this.initialMessages.has(sessionId)) {
      const msgPath = join(this.deps.workspaces.paths(sessionId).root, INITIAL_MESSAGE_FILE);
      try {
        const message = UserMessageSchema.parse(JSON.parse(await readFile(msgPath, "utf8")));
        this.initialMessages.set(sessionId, message);
      } catch {
        // Missing or corrupt file — a research re-run degrades as before.
      }
    }
  }

  /**
   * Startup recovery (spec §4): re-enqueue every message that never finished.
   * Pending rows never started — replay them through the normal dispatch path.
   * Processing rows were interrupted by a crash mid-run; the durable
   * creator_sessions row records where the pipeline stopped — see
   * resumeInterrupted for the per-state decision. listIncomplete is
   * id-ascending and SessionQueue is per-session FIFO, so arrival order is
   * preserved. Resolves once everything is enqueued; the runs themselves
   * continue in the background (observable via events + session_messages).
   */
  async recover(): Promise<void> {
    const incomplete = await this.deps.messages.listIncomplete();
    for (const msg of incomplete) {
      await this.rehydrateState(msg.sessionId);
      // Outcomes are recorded durably inside the queued task (markDone /
      // markError); swallow the propagated rejection so one poisoned message
      // cannot crash startup.
      if (msg.status === "pending") {
        void this.processMessage(msg.sessionId, msg.id, msg.payload).catch(() => {});
      } else {
        void this.resumeInterrupted(msg.sessionId, msg.id, msg.payload).catch(() => {});
      }
    }
  }

  /**
   * A processing row means the crash interrupted this message mid-run. Decide
   * from the recovered SessionState:
   *  - running        → re-run from current_phase. Earlier phases' artifacts are
   *                     already in PG; phases are idempotent (a re-run writes a
   *                     new artifact version) and the chain continues to its
   *                     natural stop (gate / done / error).
   *  - idle           → died between markProcessing and the first state write
   *                     (e.g. mid-classification): replay from scratch.
   *  - error          → the run had already failed; mirror it on the message.
   *                     The user retries explicitly (refine/revise) — no auto-rerun.
   *  - awaiting-gate / done → the run had already parked; the work is complete.
   */
  private resumeInterrupted(
    sessionId: string,
    messageId: number,
    message: UserMessage,
  ): Promise<void> {
    return this.queue.enqueue(sessionId, async () => {
      const state = this.getState(sessionId);
      switch (state.kind) {
        case "running":
          try {
            // Re-run with the persisted refinement (if the interrupted run was
            // an adjustment) — the charge deduplicated, so dropping the text
            // would bill the user for a change that never lands.
            await this.runFromPhase(sessionId, state.phase, state.refinement);
            await this.finalizeMessage(sessionId, messageId);
          } catch (err) {
            // Without this, a throw (e.g. no handler registered for the phase)
            // would strand the row in `processing` and every subsequent boot
            // would re-enter this branch — an infinite recovery loop. Marking
            // error makes the outcome terminal; the user retries explicitly.
            await this.deps.messages.markError(messageId).catch(() => undefined);
            throw err;
          }
          return;
        case "idle":
          try {
            await this.dispatch(sessionId, message);
            await this.finalizeMessage(sessionId, messageId);
          } catch (err) {
            await this.deps.messages.markError(messageId).catch(() => undefined);
            throw err;
          }
          return;
        case "error":
          await this.deps.messages.markError(messageId);
          return;
        case "awaiting-gate":
        case "awaiting-credits":
        case "done":
          // Parked/complete for this message. A credit top-up resumes an
          // awaiting-credits run via resumeCredits(), not message replay.
          await this.deps.messages.markDone(messageId);
          return;
      }
    });
  }

  async handleMessage(sessionId: string, message: UserMessage): Promise<void> {
    await this.rehydrateState(sessionId);
    // Abort bypasses the queue AND the durable store: it must interrupt the
    // in-flight phase NOW (a queued task would wait behind it), and persisting
    // it would make startup recovery replay a stale abort against the very run
    // it just resumed. Pure keyword check — instant, no LLM round-trip. Only
    // when something is actually in flight: with no live controller there is
    // nothing to stop, and a stop-leading adjustment on a parked/done session
    // ("stop the music") must reach classification instead of vanishing.
    if (isAbortText(message.text) && this.controllers.has(sessionId)) {
      this.controllers.get(sessionId)?.abort();
      return;
    }
    // Durable before enqueue: if the process dies anywhere past this line, the
    // pending/processing row is what startup recovery replays.
    const messageId = await this.deps.messages.insert(sessionId, message);
    // Record the user's turn as a persisted, replayable event so the bubble
    // survives reload. The client otherwise only echoes it optimistically, so
    // it vanishes on revisit. Emitted before processMessage so it is sequenced
    // ahead of the phase/agent events this message triggers. The event log is
    // attached at session creation, so even the first message is captured.
    this.deps.events.emit(sessionId, {
      type: "user.message",
      text: message.text,
      ...(message.uploadedFiles && message.uploadedFiles.length > 0
        ? { files: message.uploadedFiles }
        : {}),
      ...(message.clientId ? { clientId: message.clientId } : {}),
      at: new Date().toISOString(),
    });
    return this.processMessage(sessionId, messageId, message);
  }

  /** Queue the message and advance its durable status as it is worked through. */
  private processMessage(
    sessionId: string,
    messageId: number,
    message: UserMessage,
  ): Promise<void> {
    return this.queue.enqueue(sessionId, async () => {
      await this.deps.messages.markProcessing(messageId);
      try {
        await this.dispatch(sessionId, message);
        await this.finalizeMessage(sessionId, messageId);
      } catch (err) {
        // Surface the failure so the UI doesn't sit silently on "Ready" — its
        // status is read off the event stream, and a throw here is from OUTSIDE
        // runPhase's own try (intent classification, project setup, or a debit
        // that errors), which otherwise emits nothing. runPhase already parks/
        // reports its handler errors, so only act if not already in error. Use
        // the active phase, else the first phase (the throw beat any phase).
        if (this.getState(sessionId).kind !== "error") {
          const phase = this.activePhase(sessionId) ?? FIRST_PHASE;
          const error = describeError(err);
          await this.setState(sessionId, { kind: "error", phase, error }).catch(() => undefined);
          this.deps.events.emit(sessionId, { type: "phase.error", phase, error });
        }
        // Best-effort: if markError also fails (e.g. PG outage), the row stays
        // processing and startup recovery resolves it after the next restart.
        await this.deps.messages.markError(messageId).catch(() => undefined);
        throw err;
      }
    });
  }

  /** Classify the message against the current state and run the matching action. */
  private async dispatch(sessionId: string, message: UserMessage): Promise<void> {
    const routerState = this.toRouterState(this.getState(sessionId));
    const { intent, targetPhase } = await this.deps.intentRouter.classify(message, routerState);
    switch (intent) {
      case "new-project":
        await this.startNewProject(sessionId, message);
        break;
      case "approve":
        await this.approve(sessionId);
        break;
      case "refine":
        await this.refine(sessionId, message);
        break;
      case "revise-back": {
        const target = targetPhase ?? this.previousPhaseOfActive(sessionId);
        if (target) await this.reviseBack(sessionId, target, message.text);
        break;
      }
      case "update-brief":
        await this.reviseBack(sessionId, "research", message.text);
        break;
      case "abort":
        // Defensive: state changed between the pre-classify and now; abort
        // again here. Idempotent because controllers map is empty if nothing
        // is running.
        this.controllers.get(sessionId)?.abort();
        break;
      case "branch":
      case "ask":
        // Plan 3 wires `ask` to the Pi agent. Until then, tell the user we
        // couldn't act instead of dropping the message silently.
        this.deps.events.emit(sessionId, {
          type: "intent.unhandled",
          message:
            "I can't act on that message yet. You can refine the current result, approve it at a gate, or say \"abort\".",
        });
        break;
    }
  }

  /**
   * Phase failures do not throw (runFromPhase parks the session in error state
   * and emits phase.error), so the message outcome is read off the session
   * state once dispatch returns. Known simplification: a no-op message handled
   * while the session already sits in error state is also marked error —
   * harmless, since done/error are both terminal for recovery purposes.
   */
  private async finalizeMessage(sessionId: string, messageId: number): Promise<void> {
    if (this.getState(sessionId).kind === "error") {
      await this.deps.messages.markError(messageId);
    } else {
      await this.deps.messages.markDone(messageId);
    }
  }

  private toRouterState(state: SessionState): RouterState {
    switch (state.kind) {
      case "idle":
        return { kind: "idle" };
      case "running":
      case "awaiting-gate":
      case "error":
        return { kind: state.kind, phase: state.phase };
      // For routing, treat a credit-parked session as in-progress at its phase.
      case "awaiting-credits":
        return { kind: "running", phase: state.phase };
      case "done":
        return { kind: "done", phase: state.lastPhase };
    }
  }

  private async startNewProject(sessionId: string, message: UserMessage): Promise<void> {
    const paths = await this.deps.workspaces.init(sessionId);
    this.initialMessages.set(sessionId, message);
    // Persisted so rehydrateState can restore it after a process restart.
    await writeFile(join(paths.root, INITIAL_MESSAGE_FILE), JSON.stringify(message));
    await this.runFromPhase(sessionId, "research");
  }

  private async approve(sessionId: string): Promise<void> {
    const state = this.getState(sessionId);
    if (state.kind !== "awaiting-gate") return;
    const brief = await this.getBrief(sessionId);
    const next = this.deps.phases.next(state.phase, brief);
    if (!next) {
      await this.setState(sessionId, { kind: "done", lastPhase: state.phase });
      return;
    }
    await this.runFromPhase(sessionId, next.id);
  }

  private async refine(sessionId: string, message: UserMessage): Promise<void> {
    const state = this.getState(sessionId);
    // Adjusting a finished video: render is a deterministic export that
    // ignores instructions, so re-running it alone yields an identical mp4
    // and the user's text is silently dropped. Route the adjustment to
    // compose — the authoring phase — exactly like a revise-back (downstream
    // mp4 goes stale, compose re-authors with the refinement, render follows).
    if (state.kind === "done" && state.lastPhase === "render") {
      await this.reviseBack(sessionId, "compose", message.text);
      return;
    }
    const phase = this.activePhase(sessionId);
    if (!phase) return;
    // A refine at a gate (or of a non-render done state) is new user-requested
    // work → new billing run. Error and credit-parked refines are retries of
    // the already-charged attempt and keep the current run (their debit
    // deduplicates, so retrying a failure never double-charges).
    if (state.kind === "awaiting-gate" || state.kind === "done") {
      await this.deps.sessions.incrementRunSeq(sessionId);
    }
    await this.runFromPhase(sessionId, phase, message.text);
  }

  private activePhase(sessionId: string): PhaseId | null {
    const state = this.getState(sessionId);
    if (
      state.kind === "running" ||
      state.kind === "awaiting-gate" ||
      state.kind === "awaiting-credits" ||
      state.kind === "error"
    ) {
      return state.phase;
    }
    if (state.kind === "done") return state.lastPhase;
    return null;
  }

  private previousPhaseOfActive(sessionId: string): PhaseId | null {
    const phase = this.activePhase(sessionId);
    if (!phase) return null;
    return this.deps.phases.previous(phase)?.id ?? null;
  }

  private async reviseBack(
    sessionId: string,
    target: PhaseId,
    refinement: string,
  ): Promise<void> {
    // User-requested redo of already-paid work → new billing run: the phases
    // it re-runs charge again instead of deduplicating against the first run.
    await this.deps.sessions.incrementRunSeq(sessionId);
    await markStaleDownstream(this.deps.artifacts, this.deps.phases, sessionId, target);
    await this.runFromPhase(sessionId, target, refinement);
  }

  private async getBrief(sessionId: string): Promise<Brief | null> {
    const env = await this.deps.artifacts.get<Brief>(sessionId, "brief");
    return env?.data ?? null;
  }

  private async runFromPhase(
    sessionId: string,
    phaseId: PhaseId,
    refinement?: string,
  ): Promise<void> {
    // One controller spans the whole chain (including the restore below):
    // an abort during a slow restore is observed by the loop-top check before
    // the first phase starts. Abort mid-chain (between phases) is observed the
    // same way and prevents the next runPhase from starting.
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    try {
      // Archived media (post-render cleanup, spec §5) must be back on disk
      // before a phase re-run reads it. Best-effort: when the store is
      // unreachable but the inputs are still local, the run proceeds anyway.
      if (this.deps.media) {
        await this.deps.media.restoreMissing(sessionId).catch((err) =>
          console.warn(`[media-archive] ${sessionId}: restore skipped: ${describeError(err)}`),
        );
      }
      let current: PhaseId | null = phaseId;
      let nextRefinement = refinement;
      while (current) {
        if (controller.signal.aborted) {
          const error = "Aborted";
          await this.setState(sessionId, { kind: "error", phase: current, error });
          this.deps.events.emit(sessionId, { type: "phase.error", phase: current, error });
          return;
        }
        await this.runPhase(sessionId, current, controller.signal, nextRefinement);
        nextRefinement = undefined;
        const state = this.getState(sessionId);
        if (state.kind !== "running") return;
        const brief = await this.getBrief(sessionId);
        const next = this.deps.phases.next(current, brief);
        if (!next) {
          await this.setState(sessionId, { kind: "done", lastPhase: current });
          return;
        }
        current = next.id;
      }
    } finally {
      this.controllers.delete(sessionId);
    }
  }

  private async runPhase(
    sessionId: string,
    phaseId: PhaseId,
    signal: AbortSignal,
    refinement?: string,
  ): Promise<void> {
    const config = this.deps.phases.getPhase(phaseId);
    const handler = this.deps.handlers.get(phaseId);
    if (!handler) throw new Error(`No handler registered for phase ${phaseId}`);

    // Credit gate: charge this phase before any work. Insufficient → park in
    // awaiting-credits (the runFromPhase loop stops on any non-running state),
    // emit credits.required for the chat, and run nothing. A top-up + resume
    // re-enters here; the charge is idempotent per (session, phase, run) so a
    // resumed or retried re-run of the SAME run never double-charges, while a
    // user-initiated adjustment (which bumped runSeq) charges anew. The park
    // keeps the refinement so the resumed run still applies the user's change.
    const charge = await this.chargeForPhase(sessionId, phaseId, refinement !== undefined);
    if (charge && !charge.ok) {
      await this.setState(sessionId, {
        kind: "awaiting-credits",
        phase: phaseId,
        ...(refinement !== undefined ? { refinement } : {}),
      });
      this.deps.events.emit(sessionId, {
        type: "credits.required",
        phase: phaseId,
        needed: charge.needed,
        balance: charge.balance,
      });
      return;
    }

    await this.setState(sessionId, {
      kind: "running",
      phase: phaseId,
      ...(refinement !== undefined ? { refinement } : {}),
    });
    this.deps.events.emit(sessionId, {
      type: "phase.started",
      phase: phaseId,
      at: new Date().toISOString(),
    });

    const ctx: PhaseContext = {
      sessionId,
      workspaces: this.deps.workspaces,
      artifacts: this.deps.artifacts,
      events: this.deps.events,
      initialMessage: this.initialMessages.get(sessionId),
      refinement,
      signal,
    };

    try {
      for await (const event of handler.run(ctx)) {
        this.deps.events.emit(sessionId, event);
      }
    } catch (err) {
      // undici fetch errors carry the real reason (timeout, DNS, reset) on
      // err.cause; describeError keeps it so the UI shows more than "fetch failed".
      const error = describeError(err);
      // Phase failures otherwise leave zero trace beyond this DB row — a prod
      // incident (session 238388c4) was invisible in journalctl entirely.
      console.error(`[orchestrator] ${phaseId} phase failed for session ${sessionId}: ${error}`);
      await this.setState(sessionId, { kind: "error", phase: phaseId, error });
      this.deps.events.emit(sessionId, { type: "phase.error", phase: phaseId, error });
      return;
    }

    if (config.gates?.includes("user-approve")) {
      const session = await this.deps.sessions.get(sessionId);
      if (session?.autoApprove) {
        // Auto-pilot: don't park. Record the auto-pass in the chat log via the
        // existing phase.progress path (no new ServerEvent variant), then leave
        // the state as `running` so runFromPhase advances to the next phase.
        this.deps.events.emit(sessionId, {
          type: "phase.progress",
          phase: phaseId,
          message: `Auto-approved ${phaseId}.`,
        });
        return;
      }
      await this.setState(sessionId, { kind: "awaiting-gate", phase: phaseId });
      this.deps.events.emit(sessionId, { type: "gate.awaiting", phase: phaseId });
    }
  }

  /**
   * Charge the user for `phaseId` before it runs. Returns the debit result, or
   * null when credit gating is disabled (no `credits` dep). The charge is
   * idempotent per (session, phase, runSeq): crash/top-up resumes of the same
   * run dedup, while user-initiated re-runs (refine/revise-back/update-brief
   * bump runSeq) debit again. `revision` marks a run that edits an existing
   * result — compose then charges its authoring base without the media menu.
   */
  private async chargeForPhase(
    sessionId: string,
    phaseId: PhaseId,
    revision: boolean,
  ): Promise<DebitResult | null> {
    const credits = this.deps.credits;
    if (!credits) return null;
    const session = await this.deps.sessions.get(sessionId);
    if (!session) return null;

    // Public sessions are free ONCE per account — and the grant covers the
    // INITIAL generation only (runSeq 0). Claiming is idempotent per session,
    // so every phase of that first run re-reads as free; user-initiated
    // adjustment runs (runSeq > 0) charge like any other session, otherwise
    // the grant would fund unlimited free compose re-runs.
    if (session.isPublic && session.runSeq === 0) {
      const free = await this.deps.sessions.claimFreePublicGrant(sessionId, session.userId);
      // balanceAfter is unused on the success path (runPhase only checks .ok);
      // we don't widen the orchestrator's credits dep just to report it.
      if (free) return { ok: true, balanceAfter: 0, deduplicated: false };
    }

    const ctx = await this.phaseCreditContext(sessionId);
    if (revision && phaseId === "compose") {
      // The revision discount assumes an existing composition to edit. A
      // refined compose with no prior composition (revise-back before compose
      // ever ran) authors from scratch — full menu, not the discount.
      const existing = await this.deps.artifacts.get(sessionId, "composition");
      if (existing) ctx.revision = true;
    }
    // runSeq 0 keeps the legacy un-suffixed key so sessions charged before the
    // counter existed still dedup against their ledger rows on resume.
    const baseKey = `${sessionId}:${phaseId}`;
    return credits.debit({
      userId: session.userId,
      amount: phaseCredits(phaseId, ctx),
      idempotencyKey: session.runSeq > 0 ? `${baseKey}:r${session.runSeq}` : baseKey,
      reason: "consumption",
      ref: {
        sessionId,
        phase: phaseId,
        ...(session.runSeq > 0 ? { run: session.runSeq } : {}),
      },
    });
  }

  /** Best-available inputs for sizing a phase's charge (script scene count, BGM). */
  private async phaseCreditContext(sessionId: string): Promise<PhaseCreditContext> {
    const brief = await this.getBrief(sessionId);
    const script = await this.deps.artifacts.get<{ scenes?: Array<{ narration?: string }> }>(
      sessionId,
      "script",
    );
    const scenes = script?.data?.scenes;
    const narratedScenes = Array.isArray(scenes)
      ? scenes.filter((s) => typeof s?.narration === "string" && s.narration.trim().length > 0).length
      : undefined;
    const ctx: PhaseCreditContext = {};
    if (narratedScenes !== undefined) ctx.narratedScenes = narratedScenes;
    if (brief?.constraints?.bgm !== undefined) ctx.bgm = brief.constraints.bgm;
    return ctx;
  }

  /**
   * Resume a session parked in `awaiting-credits` after the balance was topped
   * up. No-op unless the session is actually parked there. Re-runs from the
   * parked phase in the background via the per-session queue; the per-phase
   * charge now succeeds and the pipeline continues. Mirrors setAutoApprove's
   * resume (not tied to a durable message).
   */
  async resumeCredits(sessionId: string): Promise<void> {
    await this.rehydrateState(sessionId);
    const state = this.getState(sessionId);
    if (state.kind !== "awaiting-credits") return;
    const phase = state.phase;
    // Carry the parked refinement into the resumed run — dropping it would
    // re-run the phase verbatim and produce an identical result after the
    // user paid to continue their adjustment.
    const refinement = state.refinement;
    this.deps.events.emit(sessionId, { type: "credits.resumed", phase });
    void this.queue
      .enqueue(sessionId, () => this.runFromPhase(sessionId, phase, refinement))
      .catch((err) =>
        console.error(`[orchestrator] resumeCredits failed for ${sessionId}: ${describeError(err)}`),
      );
  }

  /**
   * Toggle a session's auto-approve flag. The write is awaited (so a subsequent
   * GET reflects it); when turning it on while parked at a gate, the parked run
   * is resumed in the background via the per-session queue.
   */
  async setAutoApprove(sessionId: string, value: boolean): Promise<void> {
    await this.rehydrateState(sessionId);
    await this.deps.sessions.setAutoApprove(sessionId, value);
    // Resume a parked run when auto-pilot is switched on. Intentionally NOT
    // awaited (the HTTP caller must not block on the long-running pipeline) and
    // NOT atomic with the state read: if the session is mid-phase rather than
    // parked, runPhase re-reads the flag at the next gate and skips parking
    // anyway. The enqueued approve is idempotent — approve() no-ops unless the
    // state is still `awaiting-gate` when it runs.
    if (value && this.getState(sessionId).kind === "awaiting-gate") {
      void this.queue
        .enqueue(sessionId, () => this.approve(sessionId))
        .catch((err) =>
          console.error(`[orchestrator] setAutoApprove resume failed for ${sessionId}: ${describeError(err)}`),
        );
    }
  }
}
