import { useCallback, useEffect, useRef, useState } from "react";

/**
 * `useState` mirrored to `localStorage` under a `uc.*` key — the same
 * convention as the inline `uc.autoApprove` handling, factored out now that
 * several composer preferences (mode, duration, aspect, audio toggles) need to
 * survive a refresh.
 *
 * The value initializes from `initial` (NOT from storage) so the server-rendered
 * markup and the first client render are identical — reading storage happens in a
 * mount effect, which sidesteps hydration mismatches. `accept` is an optional
 * type guard that rejects stale or corrupt stored values (e.g. a duration that is
 * no longer allowed, or a mode id that no longer exists) so a bad entry silently
 * falls back to `initial` instead of poisoning the UI.
 *
 * The returned setter takes a plain value (no updater form) and writes through to
 * storage on every change.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  accept?: (value: unknown) => value is T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(initial);
  // Keep the latest guard without making it an effect dependency — call sites
  // pass a fresh closure each render, and depending on it would re-hydrate
  // (clobbering the user's changes) on every render.
  const acceptRef = useRef(accept);
  acceptRef.current = accept;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      const guard = acceptRef.current;
      if (!guard || guard(parsed)) setValue(parsed as T);
    } catch {
      /* unreadable or corrupt storage — keep the default */
    }
  }, [key]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage unavailable or over quota — keep the in-memory value */
      }
    },
    [key],
  );

  return [value, set];
}
