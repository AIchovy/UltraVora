import type { ArtifactKind, PhaseId } from "@ultracreator/shared";
import type { ChatItem } from "@/state/session-reducer";

/** A phase's lifecycle as rendered in the conversation. */
export type PhaseStatus = "running" | "awaiting" | "error" | "done";

export type ToolStatus = "running" | "done" | "error";

export type ConversationBlock =
  | { kind: "user"; text: string; files?: string[]; at?: number }
  | {
      kind: "phase";
      phase: PhaseId;
      steps: string[];
      artifacts: { artifactKind: ArtifactKind; version: number }[];
      status: PhaseStatus;
      error?: string;
    }
  | { kind: "artifact"; artifactKind: ArtifactKind; version: number }
  | { kind: "render-done"; mp4Path: string }
  | { kind: "thinking-active"; phase: PhaseId }
  | { kind: "thinking"; phase: PhaseId; text: string }
  | { kind: "agent-text"; phase: PhaseId; text: string; isFinal: boolean }
  | {
      kind: "tool";
      phase: PhaseId;
      toolCallId: string;
      toolName: string;
      toolLabel: string;
      argsSummary?: string;
      resultSummary?: string;
      status: ToolStatus;
    }
  | { kind: "notice"; message: string };

type PhaseBlock = Extract<ConversationBlock, { kind: "phase" }>;
type ToolBlock = Extract<ConversationBlock, { kind: "tool" }>;

/**
 * Fold the flat event log into conversational blocks: user bubbles, collapsible
 * per-phase activity groups, standalone artifact chips, thinking blocks, tool
 * calls, streaming agent text, and the render result.
 *
 * Consecutive events of the same phase coalesce into one group; a superseded
 * running/awaiting group is marked done. New structured events (thinking,
 * agent-text, tool-start/end) are emitted as top-level blocks for a flat
 * timeline display.
 */
export function groupConversation(items: ChatItem[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let currentPhase: PhaseBlock | null = null;

  const closePhase = (supersede: boolean): void => {
    if (!currentPhase) return;
    if (supersede && (currentPhase.status === "running" || currentPhase.status === "awaiting")) {
      currentPhase.status = "done";
    }
    blocks.push(currentPhase);
    currentPhase = null;
  };

  const ensurePhase = (phase: PhaseId): PhaseBlock => {
    if (currentPhase && currentPhase.phase === phase) return currentPhase;
    closePhase(true);
    currentPhase = { kind: "phase", phase, steps: [], artifacts: [], status: "running" };
    return currentPhase;
  };

  for (const item of items) {
    switch (item.kind) {
      case "user-message":
        closePhase(true);
        blocks.push({
          kind: "user",
          text: item.text,
          ...(item.files ? { files: item.files } : {}),
          ...(item.at != null ? { at: item.at } : {}),
        });
        break;
      case "phase-start":
        closePhase(true);
        currentPhase = { kind: "phase", phase: item.phase, steps: [], artifacts: [], status: "running" };
        break;
      case "progress":
        ensurePhase(item.phase).steps.push(item.message);
        break;
      case "gate": {
        const block = ensurePhase(item.phase);
        block.status = "awaiting";
        break;
      }
      case "phase-error": {
        const block = ensurePhase(item.phase);
        block.status = "error";
        block.error = item.error;
        break;
      }
      case "artifact":
        if (currentPhase) {
          currentPhase.artifacts.push({ artifactKind: item.artifactKind, version: item.version });
        } else {
          blocks.push({ kind: "artifact", artifactKind: item.artifactKind, version: item.version });
        }
        break;
      case "render-done":
        closePhase(true);
        blocks.push({ kind: "render-done", mp4Path: item.mp4Path });
        break;
      case "notice":
        closePhase(true);
        blocks.push({ kind: "notice", message: item.message });
        break;
      case "thinking-active":
        // Only show as a standalone indicator when nothing else follows yet.
        // The final filter below removes it once later blocks arrive.
        blocks.push({ kind: "thinking-active", phase: item.phase });
        break;
      case "thinking": {
        // Replace the matching thinking-active placeholder with the completed
        // thinking block so users can expand and read the reasoning.
        let tIdx = -1;
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!;
          if (b.kind === "thinking-active" && b.phase === item.phase) { tIdx = i; break; }
        }
        if (tIdx >= 0) {
          blocks[tIdx] = { kind: "thinking", phase: item.phase, text: item.text };
        } else {
          blocks.push({ kind: "thinking", phase: item.phase, text: item.text });
        }
        break;
      }
      case "agent-text": {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "agent-text" && last.phase === item.phase && !last.isFinal) {
          (last as { text: string; isFinal: boolean }).text = item.text;
          (last as { text: string; isFinal: boolean }).isFinal = item.isFinal;
        } else {
          blocks.push({ kind: "agent-text", phase: item.phase, text: item.text, isFinal: item.isFinal });
        }
        break;
      }
      case "tool-start":
        blocks.push({
          kind: "tool",
          phase: item.phase,
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          toolLabel: item.toolLabel,
          argsSummary: item.argsSummary,
          status: "running",
        });
        break;
      case "tool-end": {
        let matched: ToolBlock | undefined;
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!;
          if (b.kind === "tool" && b.toolCallId === item.toolCallId) {
            matched = b as ToolBlock;
            break;
          }
        }
        if (matched) {
          matched.status = item.isError ? "error" : "done";
          matched.resultSummary = item.resultSummary;
        } else {
          blocks.push({
            kind: "tool",
            phase: item.phase,
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            toolLabel: item.toolLabel,
            resultSummary: item.resultSummary,
            status: item.isError ? "error" : "done",
          });
        }
        break;
      }
    }
  }
  closePhase(false);
  // Strip stale placeholders — keep only if it's the very last block (genuinely in progress).
  return blocks.filter((b, i) => {
    if (i === blocks.length - 1) return true;
    if (b.kind === "thinking-active") return false;
    if (b.kind === "agent-text" && !b.text) return false;
    return true;
  });
}
