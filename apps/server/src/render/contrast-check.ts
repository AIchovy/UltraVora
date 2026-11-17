/**
 * Reads `hyperframes validate --json` stdout and returns the WCAG contrast
 * failures the CLI reports but does not gate on.
 *
 * Why: `hyperframes validate` runs a contrast audit, but failures are
 * warnings — the process exits 0 and the quality gate's exit-code check ships
 * them. Meanwhile the compose system prompt tells the agent the system
 * validates contrast, so the agent is licensed not to self-check. Promote the
 * failures the same way findSevereContainerOverflows promotes overflow
 * warnings: parse the JSON the CLI already emits and feed the failures back
 * into the fix loop.
 *
 * Entry shape (dist/commands/contrast-audit.browser.js):
 *   { time, selector, text, ratio, wcagAA: boolean, large: boolean, fg, bg }
 */
import { parseJsonDocument } from "./inspect-overflow-check.js";

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Formatted descriptions of contrast-audit entries with wcagAA === false.
 * Returns [] for unparseable input — a best-effort net over the CLI's own
 * exit code, never a reason to fail a healthy run.
 */
export function findContrastFailures(validateJsonStdout: string): string[] {
  const doc = parseJsonDocument(validateJsonStdout);
  const contrast = (doc as { contrast?: unknown } | null)?.contrast;
  if (!Array.isArray(contrast)) return [];

  const failures: string[] = [];
  for (const raw of contrast) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (entry.wcagAA !== false) continue;

    const selector = asNonEmptyString(entry.selector) ?? "(unknown element)";
    const ratio = asFiniteNumber(entry.ratio);
    const required = entry.large === true ? "3:1" : "4.5:1";
    const time = asFiniteNumber(entry.time);
    const text = asNonEmptyString(entry.text);
    const fg = asNonEmptyString(entry.fg);
    const bg = asNonEmptyString(entry.bg);

    const parts = [
      time !== null ? `t=${Math.round(time * 100) / 100}s ` : "",
      `${selector} has contrast ${ratio !== null ? `${ratio}:1` : "(unknown)"}, below the WCAG AA minimum ${required}`,
      text ? ` — text "${text}"` : "",
      fg && bg ? ` (${fg} on ${bg})` : "",
      ". Raise the contrast by darkening/lightening one side or moving the text off the busy area.",
    ];
    failures.push(parts.join(""));
  }
  return failures;
}
