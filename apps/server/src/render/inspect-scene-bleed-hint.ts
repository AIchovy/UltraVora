import { parseJsonDocument } from "./inspect-overflow-check.js";

/**
 * Reads `hyperframes inspect --json` stdout and returns root-cause hints for
 * clipped_text errors blamed on a SCENE container itself.
 *
 * Why: when a decorative child (e.g. a corner shape with negative bottom/right
 * offsets) bleeds past the scene edge, the scene's scrollWidth inflates and the
 * inspector reports a full-frame clipped_text pinned on the scene's text node —
 * often only mid scene-entrance transition. The CLI's own fixHint ("widen the
 * text box") sends the fixing agent the wrong way, and the documented child
 * escape hatch (data-layout-allow-overflow) cannot change the scene's
 * scrollWidth, so re-author rounds thrash until the phase fails (prod compose,
 * 2026-07-09). The real fix is a full-size overflow:hidden clip layer.
 */

/** A scene container selector: "#scene_3", "#scene-intro" — no descendant path. */
const SCENE_SELECTOR = /^#scene[\w-]*$/i;

export function findSceneBleedHints(inspectJsonStdout: string): string[] {
  const doc = parseJsonDocument(inspectJsonStdout);
  const issues = (doc as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return [];

  const scenes = new Set<string>();
  for (const raw of issues) {
    if (typeof raw !== "object" || raw === null) continue;
    const issue = raw as Record<string, unknown>;
    if (issue.code !== "clipped_text") continue;
    const selector = typeof issue.selector === "string" ? issue.selector : "";
    if (!SCENE_SELECTOR.test(selector)) continue;
    scenes.add(selector);
  }

  return [...scenes].map(
    (selector) =>
      `clipped_text on ${selector} (the scene element itself, full-frame rect) is usually NOT a ` +
      `text problem: a decorative child (e.g. a corner shape with negative bottom/right offsets) ` +
      `bleeds past the scene's bottom/right edge and inflates the scene's scrollWidth — often only ` +
      `mid scene-entrance transition. Do NOT "widen the text box" as the CLI hint suggests, and do ` +
      `NOT add data-layout-allow-overflow to the child (it cannot shrink the scene's scrollWidth). ` +
      `Fix: move ALL bleeding decoratives into one full-size clip layer inside the scene — ` +
      `<div class="bg-layer" style="position:absolute; inset: 0; overflow: hidden; z-index:0">…</div> — ` +
      `so they stop inflating the scene's scroll box (descendant GSAP selectors still match). Only if ` +
      `the quoted text genuinely overflows while the scene is static should you also shrink/wrap it.`,
  );
}
