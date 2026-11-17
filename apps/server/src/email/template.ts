import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve relative to THIS module (not cwd) so it works from any worktree and
// in dev (tsx runs from src/). Override with EMAIL_TEMPLATES_DIR for deploys
// that don't ship the repo-root email-templates/ directory.
function defaultTemplatesDir(): string {
  // apps/server/src/email/template.ts -> repo root is four levels up.
  return join(dirname(fileURLToPath(import.meta.url)), "../../../../email-templates");
}

export function templatesDir(): string {
  return process.env.EMAIL_TEMPLATES_DIR || defaultTemplatesDir();
}

export function loadVerificationTemplate(dir = templatesDir()): string {
  // Throws ENOENT (with the offending path) if the template is missing.
  return readFileSync(join(dir, "verification-code.html"), "utf8");
}

function humanizeMinutes(minutes: number): string {
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function renderVerificationEmail(args: {
  code: string;
  expiresInMinutes: number;
  /** Pre-loaded template; defaults to reading the repo template. */
  template?: string;
}): string {
  const tpl = args.template ?? loadVerificationTemplate();
  const html = tpl
    .replaceAll("{{VERIFICATION_CODE}}", args.code)
    .replaceAll("{{EXPIRES_IN}}", humanizeMinutes(args.expiresInMinutes));
  const leftover = html.match(/\{\{[^}]+\}\}/);
  if (leftover) {
    throw new Error(`Verification email has an unreplaced placeholder: ${leftover[0]}`);
  }
  return html;
}
