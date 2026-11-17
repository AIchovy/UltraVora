import { describe, it, expect, vi } from "vitest";
import { ResendEmailService, type SendEmail } from "../../src/email/resend-email-service.js";

const template = `<p>{{VERIFICATION_CODE}} / {{EXPIRES_IN}}</p>`;

describe("ResendEmailService", () => {
  it("sends the rendered template with the configured from + subject", async () => {
    const send: SendEmail = vi.fn(async () => ({ error: null }));
    const svc = new ResendEmailService({
      apiKey: "x",
      from: "UltraVora <noreply@support.ultra-vora.com>",
      send,
      template,
    });
    await svc.sendVerificationCode({ to: "a@b.com", code: "654321", expiresInMinutes: 15 });
    const mock = vi.mocked(send);
    expect(mock).toHaveBeenCalledOnce();
    const arg = mock.mock.calls[0]![0]!;
    expect(arg.from).toBe("UltraVora <noreply@support.ultra-vora.com>");
    expect(arg.to).toBe("a@b.com");
    expect(arg.subject).toBe("Your UltraVora verification code");
    expect(arg.html).toContain("654321");
    expect(arg.html).toContain("15 minutes");
  });

  it("throws when Resend returns an error", async () => {
    const send: SendEmail = async () => ({ error: { message: "domain not verified" } });
    const svc = new ResendEmailService({ apiKey: "x", from: "f@x.com", send, template });
    await expect(
      svc.sendVerificationCode({ to: "a@b.com", code: "111111", expiresInMinutes: 5 }),
    ).rejects.toThrow(/domain not verified/);
  });
});
