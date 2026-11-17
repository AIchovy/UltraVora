"use client";
import { useState } from "react";
import { FcGoogle } from "react-icons/fc";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function GoogleButton({ callbackURL = "/" }: { callbackURL?: string }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGoogle(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Absolute URL on purpose: better-auth resolves relative callbacks
      // against its own baseURL — in cross-origin prod that's api.<domain>,
      // which has no pages, so the user would land on the API's 404.
      const absoluteCallbackURL = new URL(callbackURL, window.location.origin).toString();
      const { data, error: signInError } = await authClient.signIn.social({
        provider: "google",
        callbackURL: absoluteCallbackURL,
      });
      if (signInError || !data?.url) {
        setError("Google sign-in failed. Please try again.");
        setBusy(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Could not reach the sign-in service. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" className="w-full justify-center gap-2" disabled={busy} onClick={() => void handleGoogle()}>
        <FcGoogle className="h-4 w-4" />
        Continue with Google
      </Button>
      {error && <p role="alert" className="text-center text-xs text-destructive">{error}</p>}
    </div>
  );
}
