/**
 * Error helpers shared by phase handlers and the orchestrator.
 *
 * undici (Node's fetch) reports network failures as `TypeError: fetch failed`
 * with the actual reason (connect timeout, DNS, reset…) on `err.cause`. If we
 * only surface `err.message`, the user sees "fetch failed" and nothing else —
 * so these helpers walk the cause chain.
 */

function messageWithCode(err: Error): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && !err.message.includes(code)
    ? `${err.message} (${code})`
    : err.message;
}

/** Render an error as its message plus the full cause chain. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [messageWithCode(err)];
  const seen = new Set<unknown>([err]);
  let cause: unknown = err.cause;
  while (cause !== undefined && cause !== null && !seen.has(cause)) {
    if (cause instanceof Error) {
      seen.add(cause);
      parts.push(messageWithCode(cause));
      cause = cause.cause;
    } else {
      parts.push(String(cause));
      break;
    }
  }
  return parts.length > 1 ? `${parts[0]} (caused by: ${parts.slice(1).join(" <- ")})` : parts[0]!;
}

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const TRANSIENT_MESSAGE =
  /fetch failed|socket hang up|other side closed|premature close|^(?:stream )?terminated$|status:?\s*(408|429|500|502|503|504)\b/i;

/**
 * True when the error looks like a transient network/availability failure
 * worth retrying (connection problems, timeouts, 429/5xx). Aborts and
 * response-shape errors are NOT transient.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    if (TRANSIENT_MESSAGE.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}
