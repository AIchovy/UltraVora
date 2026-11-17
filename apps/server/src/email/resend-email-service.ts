import { Resend } from "resend";
import type { EmailService, VerificationEmail } from "./email-service.js";
import { loadVerificationTemplate, renderVerificationEmail, templatesDir } from "./template.js";

/** The single Resend send shape we depend on (injectable for tests). */
export type SendEmail = (args: {
  from: string;
  to: string;
  subject: string;
  html: string;
}) => Promise<{ error: { message: string } | null }>;

export interface ResendEmailServiceOptions {
  apiKey: string;
  from: string;
  /** Injected in tests; defaults to a real Resend client's emails.send. */
  send?: SendEmail;
  /** Pre-loaded template (tests); defaults to reading the repo template once. */
  template?: string;
}

const SUBJECT = "Your UltraVora verification code";

export class ResendEmailService implements EmailService {
  private readonly from: string;
  private readonly send: SendEmail;
  private readonly template: string;

  constructor(opts: ResendEmailServiceOptions) {
    this.from = opts.from;
    this.template = opts.template ?? loadVerificationTemplate(templatesDir());
    if (opts.send) {
      this.send = opts.send;
    } else {
      const client = new Resend(opts.apiKey);
      this.send = async ({ from, to, subject, html }) => {
        // Resend's CreateEmailOptions has extra optional fields; cast to satisfy its overloads.
        const { error } = await client.emails.send({ from, to, subject, html } as Parameters<typeof client.emails.send>[0]);
        return { error: error ? { message: error.message } : null };
      };
    }
  }

  async sendVerificationCode({ to, code, expiresInMinutes }: VerificationEmail): Promise<void> {
    const html = renderVerificationEmail({ code, expiresInMinutes, template: this.template });
    const { error } = await this.send({ from: this.from, to, subject: SUBJECT, html });
    if (error) throw new Error(`Resend failed to send verification code: ${error.message}`);
  }
}
