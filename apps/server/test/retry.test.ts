import { describe, it, expect } from "vitest";
import { withTransientRetry } from "../src/retry.js";

function transientError(): Error {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    }),
  });
}

describe("withTransientRetry", () => {
  it("retries transient failures and resolves", async () => {
    let attempts = 0;
    const result = await withTransientRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw transientError();
        return "ok";
      },
      { attempts: 3, baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("gives up after max attempts and rethrows the original error", async () => {
    let attempts = 0;
    await expect(
      withTransientRetry(
        async () => {
          attempts++;
          throw transientError();
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow(/fetch failed/);
    expect(attempts).toBe(3);
  });

  it("does not retry non-transient errors", async () => {
    let attempts = 0;
    await expect(
      withTransientRetry(
        async () => {
          attempts++;
          throw new Error("invalid prompt");
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow(/invalid prompt/);
    expect(attempts).toBe(1);
  });

  it("does not retry once the signal is aborted", async () => {
    const controller = new AbortController();
    let attempts = 0;
    await expect(
      withTransientRetry(
        async () => {
          attempts++;
          controller.abort();
          throw transientError();
        },
        { attempts: 3, baseDelayMs: 1, signal: controller.signal },
      ),
    ).rejects.toThrow(/fetch failed/);
    expect(attempts).toBe(1);
  });

  it("rejects promptly when aborted during backoff", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const promise = withTransientRetry(
      async () => {
        attempts++;
        throw transientError();
      },
      { attempts: 3, baseDelayMs: 60_000, signal: controller.signal },
    );
    const rejection = expect(promise).rejects.toThrow(/abort/i);
    setTimeout(() => controller.abort(), 5);
    await rejection;
    expect(attempts).toBe(1);
  });

  it("reports each retry through onRetry", async () => {
    const notices: Array<{ attempt: number; maxAttempts: number }> = [];
    let attempts = 0;
    await withTransientRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw transientError();
        return "ok";
      },
      {
        attempts: 3,
        baseDelayMs: 1,
        onRetry: ({ attempt, maxAttempts }) => notices.push({ attempt, maxAttempts }),
      },
    );
    expect(notices).toEqual([
      { attempt: 1, maxAttempts: 3 },
      { attempt: 2, maxAttempts: 3 },
    ]);
  });
});
