"use client";
import { useState } from "react";
import { Lock, Mail, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { checkNickname, checkPassword, nicknamePolicyMessage, passwordPolicyMessage } from "@ultracreator/shared";
import { IconInput } from "./icon-input";
import { Field } from "./field";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FieldErrors = { nickname?: string; email?: string; password?: string };

export function SignUpForm({ onSent }: { onSent: (email: string) => void }): React.ReactElement {
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    // Validate ourselves (form has noValidate) so errors render inline — a red
    // field + a red message below — instead of the browser's popup bubbles.
    const fe: FieldErrors = {};
    if (!checkNickname(nickname)) fe.nickname = nicknamePolicyMessage();
    if (!email.trim()) fe.email = "Email is required.";
    else if (!EMAIL_RE.test(email)) fe.email = "Enter a valid email address.";
    if (!checkPassword(password).ok) fe.password = passwordPolicyMessage();
    setFieldErrors(fe);
    setError(null);
    if (fe.nickname || fe.email || fe.password) return;

    setBusy(true);
    const { error: signUpError } = await authClient.signUp.email({ email, password, name: nickname });
    if (signUpError) {
      setBusy(false);
      const err = signUpError as { code?: string; message?: string };
      const exists = err.code === "USER_ALREADY_EXISTS" || /exist/i.test(err.message ?? "");
      if (exists) {
        setFieldErrors({ email: "This email is already registered — try signing in." });
      } else {
        setError(err.message ?? "Sign-up failed. Please try again.");
      }
      return;
    }
    onSent(email);
  }

  return (
    <form className="flex flex-col gap-3" noValidate onSubmit={(e) => void handleSubmit(e)}>
      <Field error={fieldErrors.nickname}>
        <IconInput
          icon={User}
          placeholder="Nickname"
          value={nickname}
          aria-invalid={fieldErrors.nickname ? true : undefined}
          onChange={(e) => { setNickname(e.target.value); setFieldErrors((f) => ({ ...f, nickname: undefined })); }}
        />
      </Field>
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
          placeholder="Create a password"
          value={password}
          aria-invalid={fieldErrors.password ? true : undefined}
          onChange={(e) => { setPassword(e.target.value); setFieldErrors((f) => ({ ...f, password: undefined })); }}
        />
      </Field>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={!nickname || !email || !password || busy}>Create account</Button>
    </form>
  );
}
