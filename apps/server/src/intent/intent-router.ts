import {
  PHASE_IDS,
  type Intent,
  type PhaseId,
  type UserMessage,
} from "@ultracreator/shared";

/** Minimal state snapshot the router needs — decoupled from SessionOrchestrator. */
export interface RouterState {
  kind: "idle" | "running" | "awaiting-gate" | "error" | "done";
  phase?: PhaseId;
}

export interface ClassifiedIntent {
  intent: Intent;
  /** Set when intent is revise-back. */
  targetPhase?: PhaseId;
}

export interface IntentRouter {
  classify(message: UserMessage, state: RouterState): Promise<ClassifiedIntent>;
}

// English abort must LEAD a short imperative ("stop", "please cancel", "stop
// the run"): a keyword mid-sentence ("make the logo stop pulsing") is an
// adjustment, not an abort, and a keyword-anywhere match used to swallow such
// messages before they reached the queue. A missed abort is still caught by
// the in-queue classification; a false positive silently kills a run.
const ABORT_LEAD_RE = /^(?:please\s+)?(?:abort|cancel|stop)\b/;
const ABORT_MAX_WORDS = 6;
const CJK_ABORT_KEYWORDS = ["停止", "取消", "中止"];
// CJK keywords are substring-matched (\b has no meaning around CJK), so they
// only count on short messages: a false-positive abort kills a running chain,
// while a missed abort is still caught by the in-queue classification.
const CJK_ABORT_MAX_LEN = 6;
const APPROVE_KEYWORDS = ["/approve", "approve", "ok", "okay", "looks good", "lgtm", "ship it"];
// Pure acknowledgements ("thanks", "looks great") — no work requested. The
// whole message must be praise: a contains-check would swallow short change
// requests like "ok add music".
const ACK_WORDS = new Set([
  "ok", "okay", "thanks", "thank", "you", "nice", "great", "perfect", "awesome",
  "cool", "love", "looks", "good", "it", "lgtm", "wow", "amazing", "this", "is", "so",
]);
const CJK_ACK_EXACT = ["谢谢", "好的", "不错", "很棒", "完美", "太棒了", "很好", "太好了"];
const ACK_MAX_LEN = 25;
const BRIEF_KEYWORDS = ["duration", "aspect", "ratio", "voiceover", "audience"];
const BRIEF_VERBS = ["update", "change", "set", "make it", "turn", "switch"];
const PHASE_NAMES = PHASE_IDS as readonly PhaseId[];

const PHASE_ORDER: PhaseId[] = [...PHASE_NAMES];
function previousPhase(p: PhaseId): PhaseId | null {
  const idx = PHASE_ORDER.indexOf(p);
  if (idx <= 0) return null;
  return PHASE_ORDER[idx - 1] ?? null;
}

function findPhaseInText(text: string): PhaseId | undefined {
  const lower = text.toLowerCase();
  for (const id of PHASE_NAMES) {
    const re = new RegExp(`\\b${id}\\b`, "i");
    if (re.test(lower)) return id;
  }
  return undefined;
}

function containsAny(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

function containsAnyWord(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase();
  return needles.some((n) => {
    // Slash-commands and multi-token phrases stay substring-matched.
    if (n.startsWith("/") || n.includes(" ")) return lower.includes(n);
    return new RegExp(`\\b${n}\\b`).test(lower);
  });
}

function isCommand(text: string, prefix: string): boolean {
  return text.trim().toLowerCase().startsWith(prefix);
}

/**
 * Pure keyword abort check. Used by the orchestrator's pre-queue bypass so
 * abort stays instant and independent of LLM availability.
 */
export function isAbortText(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (lower.startsWith("/abort")) return true;
  if (ABORT_LEAD_RE.test(lower) && lower.split(/\s+/).length <= ABORT_MAX_WORDS) return true;
  const trimmed = text.trim();
  if (trimmed.length > CJK_ABORT_MAX_LEN) return false;
  return CJK_ABORT_KEYWORDS.some((k) => trimmed.includes(k));
}

/** Short pure acknowledgement ("ok", "looks good!", "谢谢") — no work requested. */
function isAcknowledgement(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > ACK_MAX_LEN || trimmed.length === 0) return false;
  const cleaned = trimmed.toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").trim();
  if (CJK_ACK_EXACT.includes(cleaned)) return true;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((t) => ACK_WORDS.has(t));
}

export class RuleBasedIntentRouter implements IntentRouter {
  async classify(message: UserMessage, state: RouterState): Promise<ClassifiedIntent> {
    const text = message.text;

    // 1. abort — but a finished session has nothing to stop: a bare
    // stop/cancel there is chatter (ask), and longer stop-leading texts
    // ("stop the music") are adjustments that fall through to refine.
    if (isAbortText(text)) {
      if (state.kind !== "done") return { intent: "abort" };
      if (text.trim().split(/\s+/).length <= 2) return { intent: "ask" };
      // fall through
    }

    // 2. revise-back
    if (
      isCommand(text, "/back") ||
      /\b(go back to|revise|back to)\b/i.test(text)
    ) {
      const targetPhase = findPhaseInText(text)
        ?? (state.phase ? previousPhase(state.phase) ?? undefined : undefined);
      return { intent: "revise-back", targetPhase };
    }

    // 3. branch
    if (isCommand(text, "/branch")) return { intent: "branch" };

    // 4. update-brief
    if (isCommand(text, "/brief")) {
      return { intent: "update-brief" };
    }
    if (containsAny(text, BRIEF_VERBS) && containsAnyWord(text, BRIEF_KEYWORDS)) {
      return { intent: "update-brief" };
    }

    // 5. new-project
    if (state.kind === "idle" && message.constraints !== undefined) {
      return { intent: "new-project" };
    }

    // 6. approve — only when actually at a gate; otherwise treated as refine
    // (except a bare acknowledgement of a finished video, handled below)
    if (containsAnyWord(text, APPROVE_KEYWORDS) && state.kind !== "done") {
      if (state.kind === "awaiting-gate") return { intent: "approve" };
      return { intent: "refine" };
    }

    // 6a. pure praise at a gate ("perfect", "thanks") is an approval —
    // falling through to refine would bill a phase re-run for a compliment.
    if (state.kind === "awaiting-gate" && isAcknowledgement(text)) {
      return { intent: "approve" };
    }

    // 6b. a short thanks/OK on a done session is chatter, not a work request —
    // classifying it refine would re-generate (and charge for) the same video.
    if (state.kind === "done" && isAcknowledgement(text)) {
      return { intent: "ask" };
    }

    // 7. refine — any free text while there's something to refine
    if (state.kind === "awaiting-gate" || state.kind === "error" || state.kind === "done") {
      return { intent: "refine" };
    }

    // 8. fallback
    return { intent: "ask" };
  }
}
