// Single source of truth for the sign-up nickname (better-auth `name`) policy,
// shared by the server (/sign-up/email hook) and the web sign-up form so the
// rules can never drift. Policy: 3–20 chars, letters/numbers/underscores only.

export const NICKNAME_MIN_LENGTH = 3;
export const NICKNAME_MAX_LENGTH = 20;

export const NICKNAME_PATTERN = new RegExp(
  `^[A-Za-z0-9_]{${NICKNAME_MIN_LENGTH},${NICKNAME_MAX_LENGTH}}$`,
);

export function checkNickname(nickname: string): boolean {
  return NICKNAME_PATTERN.test(nickname);
}

export function nicknamePolicyMessage(): string {
  return `Nickname must be ${NICKNAME_MIN_LENGTH}–${NICKNAME_MAX_LENGTH} characters, using only letters, numbers, or underscores.`;
}
