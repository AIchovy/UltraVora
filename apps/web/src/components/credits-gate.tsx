"use client";
import { useState } from "react";
import { toast } from "sonner";
import { CreditCard, Play, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { resumeSession } from "@/lib/api-client";
import { useCredits } from "@/state/use-credits";
import { PricingDialog } from "./pricing/pricing-dialog";
import type { UiState } from "@/state/session-reducer";

interface Props {
  state: UiState["status"];
  sid: string;
  /** Full credit cost of the parked phase (from credits.required). null = unknown. */
  needed: number | null;
}

/**
 * In-session credit gate. Shown when a run pauses for insufficient credits.
 *
 * Three states, driven by the live balance (not the stale event balance):
 * - balance still loading: neutral "checking" placeholder, same footprint —
 *   claiming "out of credits" before the balance arrives flashed red-then-green
 *   for users who had already topped up.
 * - balance < needed (or fetch failed / cost unknown): red "out of credits"
 *   banner + a Buy button that opens the pricing modal.
 * - balance >= needed (topped up): a "ready to continue" banner + a Continue
 *   button that resumes the parked run. We do NOT auto-resume on top-up — the
 *   user decides when the video continues.
 */
export function CreditsGate({ state, sid, needed }: Props): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data, isPending } = useCredits();
  if (state.kind !== "awaiting-credits") return null;

  if (isPending) {
    return (
      <div className="rounded-2xl bg-muted p-3 shadow-xs">
        <div className="flex h-8 items-center">
          <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground">
            <Sparkles className="h-4 w-4 shrink-0" />
            <span>Checking your credit balance…</span>
          </p>
        </div>
      </div>
    );
  }

  const balance = data?.balance;
  const canContinue = needed !== null && balance !== undefined && balance >= needed;

  if (canContinue) {
    return (
      <div className="rounded-2xl bg-credit-ready p-3 shadow-xs">
        <div className="flex items-center justify-between gap-3">
          <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-credit-ready-foreground">
            <Sparkles className="h-4 w-4 shrink-0" />
            <span>Credits added — ready to continue your video.</span>
          </p>
          <Button
            size="sm"
            className="shrink-0 rounded-lg bg-credit-ready-foreground text-white hover:bg-credit-ready-foreground/90"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await resumeSession(sid);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Couldn't continue");
              } finally {
                setBusy(false);
              }
            }}
          >
            <Play className="mr-1 h-3.5 w-3.5" /> Continue
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-destructive/10 p-3 shadow-xs">
      <div className="flex items-center justify-between gap-3">
        <p role="alert" className="flex min-w-0 items-center gap-2 text-sm font-medium text-destructive">
          <Sparkles className="h-4 w-4 shrink-0" />
          <span>Out of credits — top up to continue your video.</span>
        </p>
        <Button
          variant="destructive"
          size="sm"
          className="shrink-0 rounded-lg"
          onClick={() => setOpen(true)}
        >
          <CreditCard className="mr-1 h-3.5 w-3.5" /> Buy credits or upgrade
        </Button>
      </div>
      <PricingDialog open={open} onOpenChange={setOpen} mode="app" />
    </div>
  );
}
