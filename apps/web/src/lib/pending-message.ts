// A one-shot handoff for the first message a session is created with on the
// Home page: stashed here, then read + cleared by the session detail page so it
// renders as the opening user bubble (the POST itself already happened on Home).
const KEY = (sid: string): string => `uc.pendingMessage.${sid}`;

export interface PendingMessage {
  text: string;
  files?: string[];
  /** Correlation id of the POSTed message, so the echoed bubble dedupes against
   *  the server's replayed user.message event. */
  clientId?: string;
}

export function setPendingMessage(sid: string, msg: PendingMessage): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY(sid), JSON.stringify(msg));
  } catch {
    // sessionStorage unavailable — the bubble just won't pre-populate.
  }
}

/** Read and remove the pending message for a session, if any. */
export function takePendingMessage(sid: string): PendingMessage | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(KEY(sid));
    if (!raw) return null;
    window.sessionStorage.removeItem(KEY(sid));
    const parsed = JSON.parse(raw) as PendingMessage;
    if (typeof parsed?.text !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
