"use client";
import { useState } from "react";
import { Lock, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { IconInput } from "./icon-input";
import { Field } from "./field";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignInForm({ callbackURL = "/" }: { callbackURL?: string }): React.ReactElement {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    // Validate ourselves (form has noValidate) so errors render inline — a red
    // field + a red message below — instead of the browser's popup bubbles.
    const fe: { email?: string; password?: string } = {};
    if (!email.trim()) fe.email = "Email is required.";
    else if (!EMAIL_RE.test(email)) fe.email = "Enter a valid email address.";
    if (!password) fe.password = "Password is required.";
    setFieldErrors(fe);
    setError(null);
    if (fe.email || fe.password) return;

    setBusy(true);
    // One generic message for every failure (wrong password, unverified,
    // Google-only, unknown email) — no provider/account enumeration.
    const { error: signInError } = await authClient.signIn.email({ email, password });
    if (signInError) {
      setBusy(false);
      setError("Email or password is incorrect.");
      return;
    }
    window.location.href = callbackURL;
  }

  return (
    <form className="flex flex-col gap-3" noValidate onSubmit={(e) => void handleSubmit(e)}>
      <Field error={fieldErrors.email}>
        <IconInput
          icon={Mail}
          type="email"
          placeholder="you@example.com"
          value={email}
          aria-invalid={fieldErrors.email ? true : undefined}
          onChange={(e) => { setEmail(e.target.value); setFieldErrors((f) => ({ ...f, email: undefined })); }}
        />
      </Field>
      <Field error={fieldErrors.password}>
        <IconInput
          icon={Lock}
          type="password"
          placeholder="Password"
          value={password}
          aria-invalid={fieldErrors.password ? true : undefined}
          onChange={(e) => { setPassword(e.target.value); setFieldErrors((f) => ({ ...f, password: undefined })); }}
        />
      </Field>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy}>Sign in</Button>
    </form>
  );
}
