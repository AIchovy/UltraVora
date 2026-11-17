"use client";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/state/use-session";
import { cn } from "@/lib/utils";
import { takePendingMessage } from "@/lib/pending-message";
import { clampSplit, CHAT_SPLIT_DEFAULT, CHAT_SPLIT_KEY, CHAT_SPLIT_MIN, CHAT_SPLIT_MAX } from "@/lib/clamp-split";
import { ChatStream } from "./chat-stream";
import { ApprovalGate } from "./approval-gate";
import { CreditsGate } from "./credits-gate";
import { AutoApproveControl } from "./auto-approve-control";
import { Composer } from "./composer";
import { PreviewPanel } from "./preview-panel";
import { isChatLoading } from "@/lib/detail-loading";
import { Skeleton } from "@/components/ui/skeleton";

interface Props { sid: string }

export function SessionPage({ sid }: Props): React.ReactElement {
  const { stream, session } = useSession(sid);
  const composerRef = useRef<HTMLDivElement>(null);
  const { addUserMessage } = stream;

  // If we arrived here straight from the Home composer, the opening message was
  // already POSTed there — replay it as the first bubble (one-shot handoff).
  useEffect(() => {
    const pending = takePendingMessage(sid);
    if (pending) addUserMessage(pending.text, pending.files, pending.clientId);
  }, [sid, addUserMessage]);
  const data = session.data;
  // Prefer the live SSE status (replayed from the persisted event log) while the
  // stream is healthy. But if the stream isn't connected or has errored and the
  // SSE view is still idle, fall back to the durable REST status so a parked or
  // errored run isn't masked as "Ready" just because the live channel dropped.
  // (REST now returns the rehydrated durable status, not the in-memory map.)
  const sseStatus = stream.uiState.status;
  const restState = data?.state;
  const streamHealthy = stream.isStreaming && stream.lastError === null;
  const sessionState =
    !streamHealthy && sseStatus.kind === "idle" && restState && restState.kind !== "idle"
      ? restState
      : sseStatus;
  const reconnecting = stream.lastError !== null;
  // While a run is in progress, any already-rendered video on the right is
  // being superseded — the video pane overlays an "updating" pill. currentPhase
  // and renderPercent only exist on the live stream; on the REST fallback the
  // pane just shows the generic label.
  const regenerating =
    sessionState.kind === "running"
      ? { phase: stream.uiState.currentPhase, renderPercent: stream.uiState.renderPercent }
      : null;

  const loading = session.isLoading;
  const chatLoading = isChatLoading({
    chatEmpty: stream.uiState.chat.length === 0,
    sessionLoading: session.isLoading,
    streaming: stream.isStreaming,
    streamErrored: stream.lastError !== null,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState(CHAT_SPLIT_DEFAULT);
  useEffect(() => {
    setLeftPct(clampSplit(Number(localStorage.getItem(CHAT_SPLIT_KEY))));
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex h-full flex-col md:flex-row"
      style={{ ["--chat-basis" as string]: `${leftPct}%` } as React.CSSProperties}
    >
      {/* Conversation zone — soft tinted panel (not white); the composer stays white */}
      <section className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col bg-muted shadow-[0_18px_40px_-28px_rgba(15,23,42,0.25)] md:w-[var(--chat-basis)] md:flex-none md:shadow-[20px_0_48px_-32px_rgba(15,23,42,0.20)]">
        <ChatHeader title={session.data?.title ?? null} state={sessionState} loading={loading} reconnecting={reconnecting} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChatStream items={stream.uiState.chat} loading={chatLoading} />
        </div>
        <div className="space-y-2.5 p-3.5" ref={composerRef}>
          {(sessionState.kind === "running" || sessionState.kind === "awaiting-gate") && (
            <AutoApproveControl
              sid={sid}
              autoApprove={data?.autoApprove ?? false}
              currentPhase={stream.uiState.currentPhase}
            />
          )}
          <ApprovalGate
            sid={sid}
            state={sessionState}
            onRefineRequested={() => composerRef.current?.querySelector("textarea")?.focus()}
          />
          <CreditsGate
            state={sessionState}
            sid={sid}
            needed={stream.uiState.creditsRequired?.needed ?? null}
          />
          <Composer sid={sid} onUserMessage={(text, files, clientId) => stream.addUserMessage(text, files, clientId)} />
        </div>
      </section>

      <ResizeHandle
        containerRef={containerRef}
        leftPct={leftPct}
        onCommit={(p) => {
          setLeftPct(p);
          localStorage.setItem(CHAT_SPLIT_KEY, String(Math.round(p)));
        }}
      />

      {/* Preview zone — lighter canvas; artifact cards float on it */}
      <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
        <PreviewPanel sid={sid} artifacts={data?.artifacts ?? []} loading={loading} regenerating={regenerating} />
      </section>
    </div>
  );
}

function ChatHeader({
  title,
  state,
  loading,
  reconnecting,
}: {
  title: string | null;
  state: { kind: string; phase?: string };
  loading: boolean;
  reconnecting: boolean;
}): React.ReactElement {
  return (
    <header className="flex items-center gap-2 px-4 py-3">
      {loading ? (
        <Skeleton className="h-4 w-40 bg-foreground/10" />
      ) : (
        <>
          <span className="truncate text-sm font-medium" title={title ?? "Untitled"}>{title ?? "Untitled"}</span>
          <StatusPill state={state} />
          {reconnecting && (
            <span
              className="shrink-0 text-xs text-muted-foreground"
              title="Lost the live connection — retrying"
            >
              Reconnecting…
            </span>
          )}
        </>
      )}
    </header>
  );
}

function StatusPill({ state }: { state: { kind: string; phase?: string } }): React.ReactElement | null {
  const label = phaseLabel(state);
  if (!label) return null;
  const tone =
    state.kind === "error"
      ? "bg-destructive/10 text-destructive"
      : state.kind === "running"
        ? "bg-primary/10 text-primary"
        : state.kind === "awaiting-gate"
          ? "bg-card text-foreground shadow-xs"
          : "bg-card/60 text-muted-foreground";
  return (
    <span className={cn("ml-auto shrink-0 rounded-full px-2.5 py-1 text-xs font-medium", tone)}>{label}</span>
  );
}

function phaseLabel(state: { kind: string; phase?: string }): string {
  if (state.kind === "idle") return "Ready";
  if (state.kind === "running") return `Running ${state.phase}`;
  if (state.kind === "awaiting-gate") return `Review ${state.phase}`;
  if (state.kind === "awaiting-credits") return "Out of credits";
  if (state.kind === "done") return "Done";
  if (state.kind === "error") return `Error · ${state.phase}`;
  return state.kind;
}

/**
 * Drag handle for the chat | preview split (desktop only). During a drag we write
 * the new width straight to the container's `--chat-basis` CSS variable so the
 * panels resize without re-rendering the React tree every frame; the final value
 * is committed to state + localStorage on release. Keyboard arrows nudge it.
 */
function ResizeHandle({
  containerRef,
  leftPct,
  onCommit,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  leftPct: number;
  onCommit: (pct: number) => void;
}): React.ReactElement {
  const latest = useRef(leftPct);

  function apply(pct: number) {
    latest.current = pct;
    containerRef.current?.style.setProperty("--chat-basis", `${pct}%`);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const move = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      apply(clampSplit(((ev.clientX - rect.left) / rect.width) * 100));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onCommit(latest.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onCommit(clampSplit(leftPct - 2));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onCommit(clampSplit(leftPct + 2));
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panels"
      aria-valuenow={Math.round(leftPct)}
      aria-valuemin={CHAT_SPLIT_MIN}
      aria-valuemax={CHAT_SPLIT_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="group relative z-20 hidden w-2 shrink-0 cursor-col-resize touch-none items-center justify-center md:flex focus-visible:outline-none"
    >
      <span className="h-10 w-1 rounded-full bg-transparent transition-colors group-hover:bg-muted-foreground/30 group-focus-visible:bg-primary/50" />
    </div>
  );
}
