import { randomUUID } from "node:crypto";

// MUST stay in sync with WorkspaceManager.SESSION_ID_PATTERN.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function newSessionId(): string {
  return randomUUID();
}

export function isValidSessionId(id: string): boolean {
  return id.length > 0 && SESSION_ID_PATTERN.test(id);
}
