"use client";
import { useEffect, useState } from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { authClient } from "@/lib/auth-client";

const RESEND_COOLDOWN_SECONDS = 60;

export function OtpVerifyForm({ email, callbackURL = "/" }: { email: string; callbackURL?: string }): React.ReactElement {
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  // A code is already sent on arrival (sign-up auto-send), so start the resend
  // gated on the same 60s cooldown. One persistent interval ticks it to 0.
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    const id = setInterval(() => setCooldown((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, []);

  async function handleVerify(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: verifyError } = await authClient.emailOtp.verifyEmail({ email, otp });
    if (verifyError) {
      setBusy(false);
      setError("That code is invalid or expired.");
      return;
    }
    window.location.href = callbackURL;
  }

  async function handleResend(): Promise<void> {
    if (cooldown > 0) return;
    setError(null);
    setResent(false);
    const { error: resendError } = await authClient.emailOtp.sendVerificationOtp({ email, type: "email-verification" });
    if (resendError) {
      setError("Could not resend the code. Please try again.");
      return;
    }
    setResent(true);
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void handleVerify(e)}>
      <p className="text-xs text-muted-foreground">We sent a 6-digit code to {email}.</p>
      <InputOTP
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        inputMode="numeric"
        aria-label="Verification code"
        value={otp}
        onChange={(value) => setOtp(value)}
        containerClassName="justify-center"
      >
        <InputOTPGroup>
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
          <InputOTPSlot index={2} />
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          <InputOTPSlot index={3} />
          <InputOTPSlot index={4} />
          <InputOTPSlot index={5} />
        </InputOTPGroup>
      </InputOTP>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {resent && <p className="text-xs text-emerald-600">A new code is on its way.</p>}
      <Button type="submit" className="w-full" disabled={otp.length !== 6 || busy}>Verify &amp; continue</Button>
      <Button type="button" variant="ghost" className="w-full" disabled={cooldown > 0} onClick={() => void handleResend()}>
        {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
      </Button>
    </form>
  );
}
