// Single source of truth for the email-signup password policy, shared by the
// server (better-auth /sign-up/email hook) and the web sign-up form so the
// rules can never drift. Policy: >= 12 chars AND a letter AND a digit AND a symbol.

export const PASSWORD_MIN_LENGTH = 12;

export interface PasswordRuleStatus {
  minLength: boolean;
  hasLetter: boolean;
  hasDigit: boolean;
  hasSymbol: boolean;
}

export function checkPassword(password: string): { ok: boolean; rules: PasswordRuleStatus } {
  const rules: PasswordRuleStatus = {
    minLength: password.length >= PASSWORD_MIN_LENGTH,
    hasLetter: /[A-Za-z]/.test(password),
    hasDigit: /[0-9]/.test(password),
    hasSymbol: /[^A-Za-z0-9]/.test(password),
  };
  return { ok: Object.values(rules).every(Boolean), rules };
}

export function passwordPolicyMessage(): string {
  return `Password must be at least ${PASSWORD_MIN_LENGTH} characters and include a letter, a number, and a symbol.`;
}
