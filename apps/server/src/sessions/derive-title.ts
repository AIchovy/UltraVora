const MAX_TITLE = 80;

/** Session title from the first user message: first non-empty line, trimmed & capped. */
export function deriveTitle(text: string): string {
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const title = firstLine.slice(0, MAX_TITLE);
  return title.length > 0 ? title : "Untitled";
}
