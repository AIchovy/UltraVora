// apps/web/src/components/approval-gate.tsx
"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Check, Pencil, PauseCircle } from "lucide-react";
import type { PhaseId } from "@ultracreator/shared";
import { postMessage } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import type { UiState } from "@/state/session-reducer";

interface Props {
  sid: string;
  state: UiState["status"];
  onRefineRequested?: () => void;
}

// What to actually DO at a gate — "Review the research." says nothing
// actionable. Phases without an entry fall back to the generic line.
const GATE_HINTS: Partial<Record<PhaseId, string>> = {
  research: "Review the brief — remove weak source images or upload better ones, then approve.",
  voiceover: "Listen to the narration in the Audio tab, then approve.",
};

export function ApprovalGate({ sid, state, onRefineRequested }: Props): React.ReactElement | null {
  const [busy, setBusy] = useState(false);
  if (state.kind !== "awaiting-gate") return null;
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-accent p-3 text-sm shadow-xs">
      <PauseCircle className="h-4 w-4 shrink-0 text-primary" />
      <span className="mr-auto font-medium text-accent-foreground">
        {GATE_HINTS[state.phase] ?? `Review the ${state.phase}.`}
      </span>
      <Button
        variant="secondary"
        size="sm"
        className="rounded-lg bg-card hover:bg-card/80"
        onClick={() => onRefineRequested?.()}
      >
        <Pencil className="mr-1 h-3.5 w-3.5" /> Refine
      </Button>
      <Button
        size="sm"
        className="rounded-lg"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await postMessage(sid, { text: "/approve" });
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Approve failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Check className="mr-1 h-3.5 w-3.5" /> Approve {state.phase}
      </Button>
    </div>
  );
}
