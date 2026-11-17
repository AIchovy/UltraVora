/**
 * Per-key serial queue: tasks enqueued with the same key run one at a time
 * in FIFO order; tasks under different keys run concurrently. Task errors do
 * not block subsequent tasks (the tail is updated regardless of resolution).
 */
export class SessionQueue {
  private tails = new Map<string, Promise<unknown>>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task); // run on both resolve and reject of prev
    // Keep the chain alive even if `next` rejects — swallow at the tail level only.
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Drop a key's chain so its tail promise is no longer retained. Call only
   * once no further tasks will be enqueued under the key (e.g. after the
   * session is deleted): any in-flight task keeps running on its own promise,
   * but the per-key entry stops leaking once the session is gone.
   */
  forget(key: string): void {
    this.tails.delete(key);
  }
}
