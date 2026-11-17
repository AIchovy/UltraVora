/** Min/max width (as a % of the container) for the session's left chat column. */
export const CHAT_SPLIT_MIN = 25; // left never narrower than a quarter
export const CHAT_SPLIT_MAX = 50; // neither side wider than half
export const CHAT_SPLIT_DEFAULT = 40;
export const CHAT_SPLIT_KEY = "uc.chatSplit";

/** Clamp a left-column percentage into the allowed resize range. */
export function clampSplit(pct: number): number {
  if (Number.isNaN(pct)) return CHAT_SPLIT_DEFAULT;
  return Math.min(CHAT_SPLIT_MAX, Math.max(CHAT_SPLIT_MIN, pct));
}
