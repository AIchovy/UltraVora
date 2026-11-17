/**
 * Reads `hyperframes inspect --json` stdout and returns the container_overflow
 * findings severe enough to fail the compose gate.
 *
 * Why: the CLI classifies non-text overflow (an <img> logo wider than the
 * canvas escaping a clipping .scene) as WARNING severity, and warnings exit 0
 * without --strict — so an exit-code-only gate ships them (session e871ba4d).
 * We promote only meaningful magnitudes; tolerance-level bleeds (shadows,
 * rounding) stay warnings, and intentional overflow keeps its documented
 * escape hatch (data-layout-allow-overflow), which every fixHint names.
 */

/** Overflow below this many px is never promoted, whatever the container. */
export const SEVERE_OVERFLOW_MIN_PX = 12;
/** Overflow is severe past this fraction of the container's dimension. */
export const SEVERE_OVERFLOW_CONTAINER_FRACTION = 0.02;

const SIDES = ["left", "right", "top", "bottom"] as const;
type Side = (typeof SIDES)[number];

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** stdout may carry tooling noise around the JSON document; parse the widest {...} slice. */
export function parseJsonDocument(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    const first = stdout.indexOf("{");
    const last = stdout.lastIndexOf("}");
    if (first === -1 || last <= first) return null;
    try {
      return JSON.parse(stdout.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

function formatSeconds(value: number): string {
  return `${Math.round(value * 100) / 100}`;
}

function timeLabel(issue: Record<string, unknown>): string {
  const first = asFiniteNumber(issue.firstSeen) ?? asFiniteNumber(issue.time);
  if (first === null) return "";
  const last = asFiniteNumber(issue.lastSeen);
  const range =
    last !== null && last > first
      ? `t=${formatSeconds(first)}-${formatSeconds(last)}s`
      : `t=${formatSeconds(first)}s`;
  return `${range} `;
}

/**
 * Formatted descriptions of container_overflow issues whose overflow exceeds
 * max(SEVERE_OVERFLOW_MIN_PX, fraction of the container dimension) on any
 * side. Returns [] for unparseable input — this is a best-effort net over the
 * CLI's own exit code, never a reason to fail a healthy run.
 */
export function findSevereContainerOverflows(inspectJsonStdout: string): string[] {
  const doc = parseJsonDocument(inspectJsonStdout);
  const issues = (doc as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return [];

  const violations: string[] = [];
  for (const raw of issues) {
    if (typeof raw !== "object" || raw === null) continue;
    const issue = raw as Record<string, unknown>;
    if (issue.code !== "container_overflow") continue;
    const overflow = issue.overflow;
    if (typeof overflow !== "object" || overflow === null) continue;

    const containerRect = (issue.containerRect ?? {}) as Record<string, unknown>;
    const severeSides: string[] = [];
    for (const side of SIDES) {
      const px = asFiniteNumber((overflow as Record<Side, unknown>)[side]);
      if (px === null) continue;
      const dimension =
        asFiniteNumber(side === "left" || side === "right" ? containerRect.width : containerRect.height) ?? 0;
      const threshold = Math.max(
        SEVERE_OVERFLOW_MIN_PX,
        dimension * SEVERE_OVERFLOW_CONTAINER_FRACTION,
      );
      if (px > threshold) severeSides.push(`${side} ${px}px`);
    }
    if (severeSides.length === 0) continue;

    const selector = asNonEmptyString(issue.selector) ?? "(unknown element)";
    const container = asNonEmptyString(issue.containerSelector) ?? "its clipping container";
    const message =
      asNonEmptyString(issue.message) ?? "Element extends outside a clipping layout container.";
    const fixHint = asNonEmptyString(issue.fixHint);
    violations.push(
      `${timeLabel(issue)}${selector} inside ${container} overflows by ${severeSides.join(", ")} — ${message}${fixHint ? ` Fix: ${fixHint}` : ""}`,
    );
  }
  return violations;
}
