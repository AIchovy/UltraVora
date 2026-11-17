"use client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SERVER_EVENT_TYPES } from "@ultracreator/shared";
import { initialUiState, reduce, type UiState } from "./session-reducer.js";
import { apiBase } from "@/lib/api-base";
import type { CreditsResponse, SequencedEvent } from "@/lib/api-types";

type ReducerAction =
  | { type: "server"; envelope: SequencedEvent }
  | { type: "user"; text: string; files?: string[]; at: number; clientId?: string };

function uiReducer(state: UiState, action: ReducerAction): UiState {
  if (action.type === "user") {
    // Dedupe: if the server's replayed user.message (same clientId) already
    // landed first, don't add a second bubble.
    if (
      action.clientId &&
      state.chat.some((c) => c.kind === "user-message" && c.clientId === action.clientId)
    ) {
      return state;
    }
    return {
      ...state,
      chat: [
        ...state.chat,
        {
          kind: "user-message",
          text: action.text,
          at: action.at,
          ...(action.files ? { files: action.files } : {}),
          ...(action.clientId ? { clientId: action.clientId } : {}),
        },
      ],
    };
  }
  return reduce(state, action.envelope.event);
}

export interface UseSessionStreamResult {
  uiState: UiState;
  isStreaming: boolean;
  lastError: Event | null;
  /** Echo a message the user just sent into the conversation timeline. */
  addUserMessage: (text: string, files?: string[], clientId?: string) => void;
}

export function useSessionStream(sid: string): UseSessionStreamResult {
  const [uiState, dispatch] = useReducer(uiReducer, initialUiState);
  const [isStreaming, setIsStreaming] = useState(false);
  const [lastError, setLastError] = useState<Event | null>(null);
  const seenSeq = useRef<number>(0);
  const qc = useQueryClient();
  const addUserMessage = useCallback(
    (text: string, files?: string[], clientId?: string) =>
      dispatch({ type: "user", text, files, clientId, at: Date.now() }),
    [],
  );

  useEffect(() => {
    seenSeq.current = 0;
    const url = `${apiBase()}/api/sessions/${sid}/stream?lastEventId=0`;
    // withCredentials so the session cookie is sent when apiBase() is a different
    // origin (prod cross-subdomain). No effect same-origin.
    const es = new EventSource(url, { withCredentials: true });
    const handle = (raw: MessageEvent) => {
      try {
        const envelope = JSON.parse(raw.data) as SequencedEvent;
        if (envelope.seq <= seenSeq.current) return;
        seenSeq.current = envelope.seq;
        dispatch({ type: "server", envelope });
        const ev = envelope.event;
        if (ev.type === "artifact.created" || ev.type === "artifact.stale") {
          // stale: a re-run superseded this artifact — refetch so the tabs'
          // stale badges (from descriptor.stale) flip promptly.
          qc.invalidateQueries({ queryKey: ["artifact", sid, ev.kind] });
          qc.invalidateQueries({ queryKey: ["artifacts", sid] });
          qc.invalidateQueries({ queryKey: ["session", sid] });
        } else if (ev.type === "credits.required") {
          // The server reports the authoritative balance at the moment it parked.
          // Patch the cached balance immediately so the in-session gate's
          // affordability check (balance >= needed) is correct — a stale-high
          // balance otherwise makes it offer "Continue" when the user can't pay,
          // which re-parks instantly and flickers. Invalidate too, so a later
          // top-up (or replayed-stale event) is reconciled against the server.
          const balance = ev.balance;
          qc.setQueryData<CreditsResponse>(["credits"], (prev) =>
            prev ? { ...prev, balance } : prev,
          );
          qc.invalidateQueries({ queryKey: ["credits"] });
        } else if (ev.type === "phase.started" || ev.type === "credits.resumed") {
          // A phase just charged (or is about to) — refresh so the balance badge
          // and gate reflect the deduction.
          qc.invalidateQueries({ queryKey: ["credits"] });
        }
      } catch {
        // Malformed frame — ignore.
      }
    };
    for (const type of SERVER_EVENT_TYPES) es.addEventListener(type, handle);
    es.onopen = () => setIsStreaming(true);
    es.onerror = (ev) => {
      setIsStreaming(false);
      setLastError(ev);
    };
    return () => {
      for (const type of SERVER_EVENT_TYPES) es.removeEventListener(type, handle);
      es.close();
    };
  }, [sid, qc]);

  return { uiState, isStreaming, lastError, addUserMessage };
}
