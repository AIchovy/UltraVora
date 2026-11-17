import type { ArtifactKind, PhaseId, ServerEvent } from "@ultracreator/shared";
import type { SessionState } from "@/lib/api-types";

export type ChatItem =
  | { kind: "user-message"; text: string; files?: string[]; at?: number; clientId?: string }
  | { kind: "phase-start"; phase: PhaseId; at: string }
  | { kind: "progress"; phase: PhaseId; message: string }
  | { kind: "phase-error"; phase: PhaseId; error: string }
  | { kind: "gate"; phase: PhaseId }
  | { kind: "artifact"; artifactKind: ArtifactKind; version: number }
  | { kind: "render-done"; mp4Path: string }
  | { kind: "thinking-active"; phase: PhaseId }
  | { kind: "thinking"; phase: PhaseId; text: string }
  | { kind: "agent-text"; phase: PhaseId; text: string; isFinal: boolean }
  | { kind: "tool-start"; phase: PhaseId; toolCallId: string; toolName: string; toolLabel: string; argsSummary?: string }
  | { kind: "tool-end"; phase: PhaseId; toolCallId: string; toolName: string; toolLabel: string; resultSummary?: string; isError: boolean }
  | { kind: "notice"; message: string };

export interface UiState {
  status: SessionState | { kind: "done" };
  chat: ChatItem[];
  currentPhase: PhaseId | null;
  renderPercent: number;
  mp4Path: string | null;
  lastError: { phase: PhaseId | "render"; error: string } | null;
  latestArtifacts: Partial<Record<ArtifactKind, number>>;
  /** Set while the run is paused for credits; the in-chat gate reads it. */
  creditsRequired: { phase: PhaseId; needed: number; balance: number } | null;
}

export const initialUiState: UiState = {
  status: { kind: "idle" },
  chat: [],
  currentPhase: null,
  renderPercent: 0,
  mp4Path: null,
  lastError: null,
  latestArtifacts: {},
  creditsRequired: null,
};

function clampPercent(p: number): number {
  if (p < 0) return 0;
  if (p > 100) return 100;
  return p;
}

export function reduce(state: UiState, event: ServerEvent): UiState {
  switch (event.type) {
    case "phase.started":
      return {
        ...state,
        status: { kind: "running", phase: event.phase },
        currentPhase: event.phase,
        // Zero the previous run's percentage so a re-run doesn't open at a
        // stale 100% (only render.progress moves it back up).
        renderPercent: 0,
        creditsRequired: null,
        chat: [...state.chat, { kind: "phase-start", phase: event.phase, at: event.at }],
      };
    case "credits.required":
      return {
        ...state,
        status: { kind: "awaiting-credits", phase: event.phase },
        creditsRequired: { phase: event.phase, needed: event.needed, balance: event.balance },
        chat: [
          ...state.chat,
          {
            kind: "notice",
            message: `Out of credits — the ${event.phase} step needs ${event.needed} credits. Top up to continue.`,
          },
        ],
      };
    case "credits.resumed":
      // The user topped up and continued: the parked phase is being re-run.
      // Flip out of awaiting-credits right away so the gate doesn't paint the
      // red "out of credits" banner in the gap before phase.started/gate.awaiting.
      return {
        ...state,
        status: { kind: "running", phase: event.phase },
        currentPhase: event.phase,
        creditsRequired: null,
        chat: [...state.chat, { kind: "notice", message: "Resuming…" }],
      };
    case "phase.progress":
      return {
        ...state,
        chat: [...state.chat, { kind: "progress", phase: event.phase, message: event.message }],
      };
    case "phase.error":
      return {
        ...state,
        status: { kind: "error", phase: event.phase, error: event.error },
        chat: [...state.chat, { kind: "phase-error", phase: event.phase, error: event.error }],
        lastError: { phase: event.phase, error: event.error },
      };
    case "gate.awaiting":
      return {
        ...state,
        status: { kind: "awaiting-gate", phase: event.phase },
        chat: [...state.chat, { kind: "gate", phase: event.phase }],
      };
    case "artifact.created":
      return {
        ...state,
        latestArtifacts: { ...state.latestArtifacts, [event.kind]: event.version },
        chat: [...state.chat, { kind: "artifact", artifactKind: event.kind, version: event.version }],
      };
    case "artifact.stale":
      // UI uses descriptor.stale for display; reducer-level state untouched.
      return state;
    case "render.progress":
      return { ...state, renderPercent: clampPercent(event.percent), currentPhase: "render" };
    case "render.done":
      return {
        ...state,
        status: { kind: "done" },
        mp4Path: event.mp4Path,
        renderPercent: 100,
        chat: [...state.chat, { kind: "render-done", mp4Path: event.mp4Path }],
      };
    case "render.error":
      return {
        ...state,
        status: { kind: "error", phase: "render", error: event.error },
        lastError: { phase: "render", error: event.error },
        chat: [...state.chat, { kind: "phase-error", phase: "render", error: event.error }],
      };
    case "agent.thinking_start":
      return {
        ...state,
        chat: [...state.chat, { kind: "thinking-active", phase: event.phase }],
      };
    case "agent.thinking": {
      const chat = [...state.chat];
      let lastIdx = -1;
      for (let i = chat.length - 1; i >= 0; i--) {
        const c = chat[i]!;
        if (c.kind === "thinking-active" && c.phase === event.phase) { lastIdx = i; break; }
      }
      if (lastIdx >= 0) {
        chat[lastIdx] = { kind: "thinking", phase: event.phase, text: event.text };
      } else {
        chat.push({ kind: "thinking", phase: event.phase, text: event.text });
      }
      return { ...state, chat };
    }
    case "agent.text": {
      const chat = [...state.chat];
      const last = chat[chat.length - 1];
      if (last && last.kind === "agent-text" && last.phase === event.phase && !last.isFinal) {
        chat[chat.length - 1] = { kind: "agent-text", phase: event.phase, text: event.text, isFinal: event.isFinal };
      } else {
        chat.push({ kind: "agent-text", phase: event.phase, text: event.text, isFinal: event.isFinal });
      }
      return { ...state, chat };
    }
    case "agent.tool_start":
      return {
        ...state,
        chat: [...state.chat, {
          kind: "tool-start",
          phase: event.phase,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolLabel: event.toolLabel,
          argsSummary: event.argsSummary,
        }],
      };
    case "agent.tool_end":
      return {
        ...state,
        chat: [...state.chat, {
          kind: "tool-end",
          phase: event.phase,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolLabel: event.toolLabel,
          resultSummary: event.resultSummary,
          isError: event.isError,
        }],
      };
    case "user.message": {
      // The user's own turn, replayed from the persisted log (so it survives
      // reload). Dedupe against the optimistic echo the client added on send —
      // same clientId means the bubble is already on screen.
      if (
        event.clientId &&
        state.chat.some((c) => c.kind === "user-message" && c.clientId === event.clientId)
      ) {
        return state;
      }
      return {
        ...state,
        chat: [
          ...state.chat,
          {
            kind: "user-message",
            text: event.text,
            ...(event.files ? { files: event.files } : {}),
            ...(event.clientId ? { clientId: event.clientId } : {}),
            at: Date.parse(event.at),
          },
        ],
      };
    }
    case "intent.unhandled":
      return {
        ...state,
        chat: [...state.chat, { kind: "notice", message: event.message }],
      };
    default:
      return state;
  }
}
