/**
 * Static guard against the GSAP "blank scene" trap.
 *
 * Scenes start hidden — the composition does `gsap.set(".scene", {autoAlpha:0})`
 * (and base CSS `opacity:0; visibility:hidden`). A bare `gsap.from()` /
 * `tl.from()` that animates `opacity`/`autoAlpha` on such a container captures
 * its END value from the element's CURRENT (hidden) opacity 0 — so it tweens
 * 0→0 and the scene never appears (renders blank). The compose system-prompt
 * already forbids this, but the LLM occasionally ignores it; this turns the
 * rule into an enforced check fed back to the agent.
 *
 * Allowed (NOT flagged): opacity fades on a scene's CHILDREN (base opacity 1),
 * transform/filter entrances on the container (x/y/scale), and `fromTo()` with
 * an explicit end (e.g. `fromTo("#scene", {autoAlpha:0}, {autoAlpha:1})`).
 */

/** Ids of elements whose class list includes `scene` — the hidden containers. */
function sceneContainerIds(html: string): Set<string> {
  const ids = new Set<string>();
  const openTag = /<[a-zA-Z][a-zA-Z0-9]*\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = openTag.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const cls = /\bclass\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? "";
    if (!/\bscene\b/.test(cls)) continue;
    const id = /\bid\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Does `sub` (a single, trimmed selector) target a hidden container ITSELF —
 * i.e. `#<sceneId>` or the bare `.scene` class, with no descendant combinator?
 * `#scene_1 .logo` (a child) returns false.
 */
function targetsContainerItself(sub: string, ids: Set<string>): boolean {
  if (/[\s>+~]/.test(sub)) return false; // has a combinator → descendant, not the container
  if (sub === ".scene") return true;
  const idMatch = /^#([A-Za-z0-9_-]+)$/.exec(sub);
  return idMatch !== null && ids.has(idMatch[1]!);
}

/**
 * Returns one human-readable message per violation; empty array means clean.
 */
export function findHiddenContainerOpacityFroms(html: string): string[] {
  const ids = sceneContainerIds(html);
  const messages: string[] = [];
  const seen = new Set<string>();

  // `tl.from(` / `gsap.from(` with a string-literal target + a flat vars object.
  // `from\s*\(` does not match `fromTo(` (the char after "from" is "T").
  const fromCall = /\b(?:gsap|tl)\s*\.\s*from\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = fromCall.exec(html)) !== null) {
    const target = m[2] ?? "";
    const vars = m[3] ?? "";
    if (!/\b(?:opacity|autoAlpha)\s*:/.test(vars)) continue;
    for (const sub of target.split(",").map((s) => s.trim())) {
      if (!targetsContainerItself(sub, ids) || seen.has(sub)) continue;
      seen.add(sub);
      messages.push(
        `Scene container "${sub}" is revealed with gsap.from({opacity|autoAlpha}); it starts hidden, ` +
          `so from() captures its end value as 0 and the scene renders blank. Transition the container ` +
          `with transform (x/y/scale) or use fromTo("${sub}", {autoAlpha:0}, {autoAlpha:1, ...}), and put ` +
          `opacity fades on its children instead.`,
      );
    }
  }
  return messages;
}
