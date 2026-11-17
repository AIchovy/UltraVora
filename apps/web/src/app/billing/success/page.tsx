"use client";
// Post-checkout landing. Creem redirects here after payment; the credits
// arrive via webhook a moment later, so poll the balance until it moves
// (or reassure + stop after a minute).
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { getPlan, type PlanTier } from "@ultracreator/shared";
import { getCredits } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

const POLL_MS = 2000;
const TIMEOUT_MS = 60_000;

type Phase = "waiting" | "done" | "timeout";

// next build requires a Suspense boundary around useSearchParams consumers.
export default function BillingSuccessPage(): React.ReactElement {
  return (
    <Suspense>
      <SuccessInner />
    </Suspense>
  );
}

function SuccessInner(): React.ReactElement {
  const params = useSearchParams();
  const kind = params.get("kind") === "subscription" ? "subscription" : "credits";
  const expectedCredits = Number(params.get("credits") ?? 0);
  const tier = params.get("tier") as PlanTier | null;

  const [phase, setPhase] = useState<Phase>("waiting");
  const baseline = useRef<number | null>(null);

  useEffect(() => {
    let stopped = false;
    const started = Date.now();

    async function tick(): Promise<void> {
      if (stopped) return;
      try {
        const c = await getCredits();
        if (baseline.current === null) baseline.current = c.balance;
        const landed =
          kind === "subscription" ? c.subscription?.tier === tier : c.balance > baseline.current;
        if (landed) {
          setPhase("done");
          return;
        }
      } catch {
        // transient — keep polling until the timeout
      }
      if (Date.now() - started >= TIMEOUT_MS) {
        setPhase("timeout");
        return;
      }
      setTimeout(() => void tick(), POLL_MS);
    }
    void tick();
    return () => {
      stopped = true;
    };
  }, [kind, tier]);

  const fmt = (n: number): string => n.toLocaleString("en-US");
  const doneCopy =
    kind === "subscription" && tier
      ? `Your ${getPlan(tier).name} plan is active.`
      : `${fmt(expectedCredits)} credits added to your balance.`;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      {phase === "waiting" ? (
        <>
          <Loader2 className="size-10 animate-spin text-primary" />
          <h1 className="text-xl font-semibold">Payment received</h1>
          <p className="text-sm text-muted-foreground">
            {kind === "subscription" ? "Activating your plan…" : "Adding your credits…"}
          </p>
        </>
      ) : (
        <>
          <CheckCircle2 className="size-10 text-primary" />
          <h1 className="text-xl font-semibold">
            {phase === "done" ? doneCopy : "Payment received"}
          </h1>
          {phase === "timeout" && (
            <p className="text-sm text-muted-foreground">
              Your credits are on their way — the balance updates within a few minutes.
            </p>
          )}
        </>
      )}
      <Button asChild variant={phase === "waiting" ? "secondary" : "default"} className="mt-2">
        <Link href="/">Back to home</Link>
      </Button>
    </main>
  );
}
