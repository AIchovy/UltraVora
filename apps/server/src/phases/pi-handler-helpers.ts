import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent, ImageContent } from "@earendil-works/pi-ai";
import type { ArtifactKind, PhaseId, ServerEvent } from "@ultracreator/shared";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { describeError, isTransientNetworkError } from "../errors.js";
import { sleepUnlessAborted } from "../retry.js";

/**
 * Server-side fallback label for a tool: title-cases the snake_case tool name
 * (`read_skill_file` → "Read Skill File"). The web UI maps known tools to
 * friendlier phrases and only falls back to this for tools it doesn't know.
 */
export function toolLabel(toolName: string): string {
  return toolName
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Collapse internal whitespace and truncate to a short, single-line snippet. */
function snippet(s: string, max = 50): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

/** The friendly tail of a path. A `SKILL.md` file shows its skill's name instead. */
function friendlyPath(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  const base = parts[parts.length - 1] ?? p;
  if (/^SKILL\.(md|markdown)$/i.test(base) && parts.length >= 2) {
    return parts[parts.length - 2]!;
  }
  return base;
}

/** Hostname of a URL, falling back to the raw string if it doesn't parse. */
function hostOf(u: string): string {
  try {
    return new URL(u).host || u;
  } catch {
    return u;
  }
}

// Args are summarized to a single friendly "subject" — never a dump of every
// field, raw file contents, or an absolute path. Keys are tried in priority
// order so the most meaningful value wins (a prompt over an aspect ratio, etc.).
const PROMPT_KEYS = ["prompt", "query", "description", "text"];
const URL_KEYS = ["url"];
const PATH_KEYS = ["path", "filePath", "file", "src", "filename"];
const NAME_KEYS = ["name", "id", "item"];

export function summarizeArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const a = args as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof a[k] === "string" && (a[k] as string).length > 0 ? (a[k] as string) : undefined;

  for (const k of PROMPT_KEYS) {
    const v = str(k);
    if (v) return snippet(v);
  }
  for (const k of URL_KEYS) {
    const v = str(k);
    if (v) return hostOf(v);
  }
  for (const k of PATH_KEYS) {
    const v = str(k);
    if (v) return friendlyPath(v);
  }
  for (const k of NAME_KEYS) {
    const v = str(k);
    if (v) return snippet(v);
  }
  return undefined;
}

function resultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content) && r.content.length > 0) {
    const first = r.content[0] as Record<string, unknown> | undefined;
    if (first?.type === "text" && typeof first.text === "string") return first.text;
  }
  return undefined;
}

/**
 * On success the result is left unsummarized — the args-derived subject already
 * tells the user what the tool acted on, and a success body is usually raw file
 * contents or HTML, which read as noise. On error, surface a short reason.
 */
export function summarizeResult(result: unknown, isError: boolean): string | undefined {
  if (!isError) return undefined;
  const text = resultText(result);
  if (!text) return "Failed";
  return snippet(text, 80);
}

interface StreamingState {
  thinkingBuf: string;
  textBuf: string;
  textTimer: ReturnType<typeof setTimeout> | null;
  lastTextFlush: number;
}

const TEXT_THROTTLE_MS = 200;

function createStreamingState(): StreamingState {
  return { thinkingBuf: "", textBuf: "", textTimer: null, lastTextFlush: 0 };
}

function handleMessageUpdate(
  ame: AssistantMessageEvent,
  phase: PhaseId,
  ss: StreamingState,
  push: (event: ServerEvent) => void,
): void {
  switch (ame.type) {
    case "thinking_start":
      push({ type: "agent.thinking_start", phase });
      break;
    case "thinking_delta":
      ss.thinkingBuf += ame.delta;
      break;
    case "thinking_end":
      if (ss.thinkingBuf) {
        push({ type: "agent.thinking", phase, text: ss.thinkingBuf });
      }
      ss.thinkingBuf = "";
      break;
    case "text_delta": {
      ss.textBuf += ame.delta;
      const now = Date.now();
      if (now - ss.lastTextFlush >= TEXT_THROTTLE_MS) {
        push({ type: "agent.text", phase, text: ss.textBuf, isFinal: false });
        ss.lastTextFlush = now;
      } else if (!ss.textTimer) {
        ss.textTimer = setTimeout(() => {
          ss.textTimer = null;
          push({ type: "agent.text", phase, text: ss.textBuf, isFinal: false });
          ss.lastTextFlush = Date.now();
        }, TEXT_THROTTLE_MS);
      }
      break;
    }
    case "text_end":
      if (ss.textTimer) {
        clearTimeout(ss.textTimer);
        ss.textTimer = null;
      }
      if (ss.textBuf) {
        push({ type: "agent.text", phase, text: ss.textBuf, isFinal: true });
      }
      ss.textBuf = "";
      break;
    default:
      break;
  }
}

function flushStreaming(ss: StreamingState, phase: PhaseId, push: (event: ServerEvent) => void): void {
  if (ss.textTimer) {
    clearTimeout(ss.textTimer);
    ss.textTimer = null;
  }
  if (ss.thinkingBuf) {
    push({ type: "agent.thinking", phase, text: ss.thinkingBuf });
    ss.thinkingBuf = "";
  }
  if (ss.textBuf) {
    push({ type: "agent.text", phase, text: ss.textBuf, isFinal: true });
    ss.textBuf = "";
  }
}

/** Retry policy for transient network failures talking to the LLM provider. */
export interface TransientAgentRetryOptions {
  /** Total attempts including the first; default 3. */
  attempts?: number;
  /** First backoff delay; doubles per retry. Default 1500ms. */
  baseDelayMs?: number;
}

// A short nudge, NOT the original prompt: the model's transcript already has
// the original user message (it never got a chance to respond to it), so
// re-sending the full prompt would duplicate potentially large content
// (a whole brief/design JSON dump) for no benefit. Explicitly warns against
// repeating a tool call: the failure can land on the turn immediately AFTER
// an earlier turn's tool call already succeeded (e.g. generate_image) — a
// bare "try again" risks the model re-issuing that same paid call.
const TRANSIENT_RETRY_PROMPT =
  "Your previous response failed due to a transient network error — this was a network " +
  "issue with your reply, not a problem with any tool call you already made. Check the " +
  "conversation above: do NOT repeat any tool call that already completed successfully. " +
  "Simply continue from where you left off.";

/**
 * Drive a Pi `Agent` to completion and yield `ServerEvent`s as work happens.
 *
 * - `phase.progress` is emitted at meaningful boundaries: tool_execution_start
 *   (so the UI sees which tool is running), tool_execution_end (with a short
 *   summary of the result), and turn_end (so the UI sees natural progress between turns).
 * - Errors from the agent are thrown so the orchestrator's `runPhase` catches them
 *   and emits `phase.error`.
 * - A transient network failure (per isTransientNetworkError — e.g. undici's
 *   generic "fetch failed") re-prompts the SAME agent in place with a short
 *   nudge, exponential backoff between attempts. This mirrors
 *   VoiceoverPhaseHandler's inline retry policy (see retry.ts) — prod session
 *   238388c4 hit exactly this class of error during the design phase with no
 *   retry anywhere in the chain, killing the whole session over one blip.
 *
 * Note: `artifact.created` is NOT emitted here — `ArtifactStore.put` (called from
 * inside artifact-write tools) emits it directly via EventBus.
 */
export async function* runAgentToCompletion(opts: {
  phase: PhaseId;
  agent: Agent;
  prompt: string;
  /** Attached to the FIRST attempt only; retries continue the same transcript. */
  images?: ImageContent[];
  signal?: AbortSignal;
  retry?: TransientAgentRetryOptions;
}): AsyncIterable<ServerEvent> {
  const maxAttempts = opts.retry?.attempts ?? 3;
  const baseDelayMs = opts.retry?.baseDelayMs ?? 1500;

  for (let attempt = 1; ; attempt++) {
    // Checked BEFORE every turn (including the first), not just after a
    // failure: a cancel that lands during the backoff sleep below, or in any
    // caller-side gap before this function is even invoked, must never let
    // another (potentially billable) turn start. `signal.aborted` stays true
    // forever once set, so this is reliable regardless of whether
    // PiAgentFactory's one-shot abort→agent.abort() bridge happened to fire
    // while the agent was idle (a no-op in that case).
    if (opts.signal?.aborted) throw new Error("Aborted");
    const prompt = attempt === 1 ? opts.prompt : TRANSIENT_RETRY_PROMPT;
    const images = attempt === 1 ? opts.images : undefined;
    const error = yield* runAgentTurn({ phase: opts.phase, agent: opts.agent, prompt, images });
    if (!error) return;
    if (attempt >= maxAttempts || opts.signal?.aborted || !isTransientNetworkError(error)) {
      throw error;
    }
    yield {
      type: "phase.progress",
      phase: opts.phase,
      message: `Transient error: ${describeError(error)}. Retrying (attempt ${attempt + 1}/${maxAttempts})…`,
    };
    await sleepUnlessAborted(baseDelayMs * 2 ** (attempt - 1), opts.signal);
  }
}

/** One prompt/turn to its natural end. Returns (rather than throws) any error so the retry loop above can inspect it. */
async function* runAgentTurn(opts: {
  phase: PhaseId;
  agent: Agent;
  prompt: string;
  images?: ImageContent[];
}): AsyncGenerator<ServerEvent, Error | null> {
  const queue: ServerEvent[] = [];
  let waiter: (() => void) | null = null;
  let agentError: Error | null = null;

  const push = (event: ServerEvent) => {
    queue.push(event);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  const ss = createStreamingState();

  const unsubscribe = opts.agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "message_update":
        handleMessageUpdate(event.assistantMessageEvent, opts.phase, ss, push);
        break;
      case "tool_execution_start":
        push({
          type: "agent.tool_start",
          phase: opts.phase,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolLabel: toolLabel(event.toolName),
          argsSummary: summarizeArgs(event.args),
        });
        break;
      case "tool_execution_end":
        push({
          type: "agent.tool_end",
          phase: opts.phase,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolLabel: toolLabel(event.toolName),
          resultSummary: summarizeResult(event.result, event.isError),
          isError: event.isError,
        });
        break;
      case "turn_end": {
        flushStreaming(ss, opts.phase, push);
        const msg = event.message;
        if (
          msg.role === "assistant" &&
          (msg.stopReason === "error" || msg.stopReason === "aborted")
        ) {
          agentError = new Error(
            msg.errorMessage ?? `Agent turn ended with stopReason "${msg.stopReason}"`,
          );
        }
        break;
      }
      default:
        break;
    }
  });

  const runPromise = (opts.images?.length
    ? opts.agent.prompt(opts.prompt, opts.images)
    : opts.agent.prompt(opts.prompt)
  ).catch((err: unknown) => {
    agentError = err instanceof Error ? err : new Error(String(err));
  });

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      const isDone = await Promise.race([
        runPromise.then(() => "done" as const),
        new Promise<"event">((resolve) => {
          waiter = () => resolve("event");
        }),
      ]);
      if (isDone === "done") {
        flushStreaming(ss, opts.phase, push);
        while (queue.length > 0) yield queue.shift()!;
        break;
      }
    }
  } finally {
    unsubscribe();
  }

  return agentError;
}

/**
 * Drive the stateful compose agent for one prompt and yield `ServerEvent`s.
 *
 * Mirrors {@link runAgentToCompletion}. The event mapping is identical:
 * `tool_execution_start/end` → progress, `turn_end` → surface a
 * failed/aborted `stopReason` as a thrown error. Like the low-level agent,
 * `harness.prompt()` does NOT reject on a failed LLM request.
 *
 * Calling this repeatedly on the SAME agent continues the same session, which
 * is what the compose re-author loop relies on. Same transient-network retry
 * policy as {@link runAgentToCompletion} (see its doc comment).
 */
export async function* runHarnessToCompletion(opts: {
  phase: PhaseId;
  harness: Agent;
  prompt: string;
  signal?: AbortSignal;
  retry?: TransientAgentRetryOptions;
}): AsyncIterable<ServerEvent> {
  const maxAttempts = opts.retry?.attempts ?? 3;
  const baseDelayMs = opts.retry?.baseDelayMs ?? 1500;

  for (let attempt = 1; ; attempt++) {
    // See the matching check in runAgentToCompletion for why this must run
    // before every turn, not just after a failure.
    if (opts.signal?.aborted) throw new Error("Aborted");
    const prompt = attempt === 1 ? opts.prompt : TRANSIENT_RETRY_PROMPT;
    const error = yield* runHarnessTurn({ phase: opts.phase, harness: opts.harness, prompt });
    if (!error) return;
    if (attempt >= maxAttempts || opts.signal?.aborted || !isTransientNetworkError(error)) {
      throw error;
    }
    yield {
      type: "phase.progress",
      phase: opts.phase,
      message: `Transient error: ${describeError(error)}. Retrying (attempt ${attempt + 1}/${maxAttempts})…`,
    };
    await sleepUnlessAborted(baseDelayMs * 2 ** (attempt - 1), opts.signal);
  }
}

/** One prompt/turn to its natural end. Returns (rather than throws) any error so the retry loop above can inspect it. */
async function* runHarnessTurn(opts: {
  phase: PhaseId;
  harness: Agent;
  prompt: string;
}): AsyncGenerator<ServerEvent, Error | null> {
  const queue: ServerEvent[] = [];
  let waiter: (() => void) | null = null;
  let agentError: Error | null = null;

  const push = (event: ServerEvent) => {
    queue.push(event);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  const ss = createStreamingState();

  const unsubscribe = opts.harness.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "message_update":
        handleMessageUpdate(
          (event as { assistantMessageEvent: AssistantMessageEvent }).assistantMessageEvent,
          opts.phase,
          ss,
          push,
        );
        break;
      case "tool_execution_start":
        push({
          type: "agent.tool_start",
          phase: opts.phase,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolLabel: toolLabel(event.toolName),
          argsSummary: summarizeArgs(event.args),
        });
        break;
      case "tool_execution_end":
        push({
          type: "agent.tool_end",
          phase: opts.phase,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolLabel: toolLabel(event.toolName),
          resultSummary: summarizeResult(event.result, event.isError),
          isError: event.isError,
        });
        break;
      case "turn_end": {
        flushStreaming(ss, opts.phase, push);
        const msg = event.message;
        if (msg.role === "assistant" && (msg.stopReason === "error" || msg.stopReason === "aborted")) {
          agentError = new Error(
            msg.errorMessage ?? `Agent turn ended with stopReason "${msg.stopReason}"`,
          );
        }
        break;
      }
      default:
        break;
    }
  });

  const runPromise = opts.harness.prompt(opts.prompt).then(
    () => undefined,
    (err: unknown) => {
      agentError = err instanceof Error ? err : new Error(String(err));
    },
  );

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      const isDone = await Promise.race([
        runPromise.then(() => "done" as const),
        new Promise<"event">((resolve) => {
          waiter = () => resolve("event");
        }),
      ]);
      if (isDone === "done") {
        flushStreaming(ss, opts.phase, push);
        while (queue.length > 0) yield queue.shift()!;
        break;
      }
    }
  } finally {
    unsubscribe();
  }

  return agentError;
}

/**
 * Drive a Pi agent that is expected to persist a specific artifact via a
 * write_* tool, and guarantee it actually did.
 *
 * Real models sometimes end their turn with a prose summary instead of calling
 * the required tool, which leaves the phase "successful" but with no artifact —
 * the next phase then fails confusingly ("requires a <kind> artifact, none
 * found"). When that happens we re-prompt the same agent with an explicit
 * reminder (up to `maxNudges` times). If no fresh artifact appears after the
 * budget is spent, we throw a clear error attributed to THIS phase.
 */
export async function* runAgentForArtifact(opts: {
  phase: PhaseId;
  agent: Agent;
  prompt: string;
  /** Image blocks attached to the initial prompt (multimodal grounding). */
  images?: ImageContent[];
  artifacts: ArtifactStore;
  sessionId: string;
  kind: ArtifactKind;
  toolName: string;
  /** Extra re-prompts after the initial attempt. Default 2 (3 attempts total). */
  maxNudges?: number;
  signal?: AbortSignal;
  retry?: TransientAgentRetryOptions;
}): AsyncIterable<ServerEvent> {
  const maxNudges = opts.maxNudges ?? 2;
  // A stale artifact from a prior run must not count as "produced this run", so
  // require the version to strictly increase past whatever exists now.
  const before = await opts.artifacts.get(opts.sessionId, opts.kind);
  const beforeVersion = before?.version ?? 0;
  const produced = async (): Promise<boolean> => {
    const env = await opts.artifacts.get(opts.sessionId, opts.kind);
    return !!env && env.version > beforeVersion;
  };

  yield* runAgentToCompletion({
    phase: opts.phase,
    agent: opts.agent,
    prompt: opts.prompt,
    images: opts.images,
    signal: opts.signal,
    retry: opts.retry,
  });

  for (let nudge = 0; nudge < maxNudges && !(await produced()); nudge++) {
    yield {
      type: "phase.progress",
      phase: opts.phase,
      message: `Still finishing the ${opts.kind}…`,
    };
    yield* runAgentToCompletion({
      phase: opts.phase,
      agent: opts.agent,
      prompt: `You have not called ${opts.toolName} yet, so no ${opts.kind} was saved. Call ${opts.toolName} now with the complete ${opts.kind} object. Respond with that tool call only — do not reply with prose.`,
      signal: opts.signal,
      retry: opts.retry,
    });
  }

  if (!(await produced())) {
    throw new Error(
      `${opts.phase} phase did not produce a ${opts.kind} artifact after ${maxNudges + 1} attempts`,
    );
  }
}
