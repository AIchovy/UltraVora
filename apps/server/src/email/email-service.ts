export interface VerificationEmail {
  to: string;
  code: string;
  expiresInMinutes: number;
}

/**
 * Narrow seam over the email provider so auth wiring and tests never import
 * Resend directly (mirrors the AuthService pattern). Tests inject a fake.
 */
export interface EmailService {
  sendVerificationCode(email: VerificationEmail): Promise<void>;
}
