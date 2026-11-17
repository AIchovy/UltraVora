"use client";
import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LogoMark } from "@/components/logo";
import { GoogleButton } from "@/components/auth/google-button";
import { SignInForm } from "@/components/auth/sign-in-form";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { OtpVerifyForm } from "@/components/auth/otp-verify-form";

type Mode = "signin" | "signup" | "verify";

const TITLES: Record<Mode, string> = {
  signin: "Sign in to UltraVora",
  signup: "Create your UltraVora account",
  verify: "Verify your email",
};

export function LoginCard({ callbackURL = "/" }: { callbackURL?: string } = {}): React.ReactElement {
  const [mode, setMode] = useState<Mode>("signin");
  const [pendingEmail, setPendingEmail] = useState("");

  return (
    <Card className="w-full max-w-sm animate-fade-up">
      <CardHeader className="items-center text-center">
        <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs">
          <LogoMark className="h-7 w-7" />
        </span>
        <CardTitle>{TITLES[mode]}</CardTitle>
        <CardDescription>Promo videos for your product — demo, brand story, social clip, or anything.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {mode === "verify" ? (
          <OtpVerifyForm email={pendingEmail} callbackURL={callbackURL} />
        ) : (
          <>
            <GoogleButton callbackURL={callbackURL} />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
            {mode === "signin" ? (
              <SignInForm callbackURL={callbackURL} />
            ) : (
              <SignUpForm onSent={(email) => { setPendingEmail(email); setMode("verify"); }} />
            )}
            <button
              type="button"
              className="cursor-pointer text-center text-xs text-muted-foreground underline"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            >
              {mode === "signin" ? "Need an account? Create one" : "Already have an account? Sign in"}
            </button>
          </>
        )}
        <p className="text-center text-xs leading-relaxed text-muted-foreground/80">
          By continuing, you agree to our{" "}
          <Link href="/terms" className="underline hover:text-foreground">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="underline hover:text-foreground">
            Privacy Policy
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}
