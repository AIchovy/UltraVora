/**
 * Return `raw` if it is a safe relative in-app path, otherwise fall back to "/".
 * Rejects protocol-relative (//) and absolute URLs to prevent open-redirect.
 */
export function safeNext(raw: string | undefined): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}
