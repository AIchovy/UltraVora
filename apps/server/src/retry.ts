import { isTransientNetworkError } from "./errors.js";

export interface TransientRetryOptions {
  /** Total attempts including the first; default 3. */
  attempts?: number;
  /** First backoff delay; doubles per retry. Default 1500ms. */
  baseDelayMs?: number;
  signal?: AbortSignal;
  /** Called before each backoff sleep. `attempt` is the attempt that just failed (1-based). */
  onRetry?: (info: { attempt: number; maxAttempts: number; error: unknown }) => void;
}

export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `fn`, retrying transient network/availability failures (per
 * isTransientNetworkError) with exponential backoff. Non-transient errors,
 * exhausted attempts, and aborts rethrow immediately.
 *
 * Note: VoiceoverPhaseHandler implements this same policy inline because it
 * must `yield` a progress event between attempts; keep the two in sync.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: TransientRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || opts.signal?.aborted || !isTransientNetworkError(err)) {
        throw err;
      }
      opts.onRetry?.({ attempt, maxAttempts, error: err });
      await sleepUnlessAborted(baseDelayMs * 2 ** (attempt - 1), opts.signal);
    }
  }
}
