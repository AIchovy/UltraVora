"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { PhaseId } from "@ultracreator/shared";
import { Switch } from "@/components/ui/switch";
import { patchSession } from "@/lib/api-client";
import type { GetSessionResponse } from "@/lib/api-types";

// Phases that run after the last user-approve gate (voiceover when enabled,
// script otherwise — see apps/server/src/phases/registry.ts). Once the run is
// in one of these there is no gate left for "pause" to catch.
const PAST_LAST_GATE: PhaseId[] = ["compose", "render"];

interface Props {
  sid: string;
  autoApprove: boolean;
  currentPhase: PhaseId | null;
}

export function AutoApproveControl({ sid, autoApprove, currentPhase }: Props): React.ReactElement {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const noGatesLeft = autoApprove && currentPhase !== null && PAST_LAST_GATE.includes(currentPhase);

  async function toggle(value: boolean): Promise<void> {
    setBusy(true);
    // Cancel any in-flight refetch of this session (the SSE stream invalidates
    // ["session", sid] on every artifact.created) so it can't clobber the
    // optimistic value mid-flight.
    await qc.cancelQueries({ queryKey: ["session", sid] });
    qc.setQueryData<GetSessionResponse | null>(["session", sid], (prev) =>
      prev ? { ...prev, autoApprove: value } : prev,
    );
    try {
      await patchSession(sid, { autoApprove: value });
      // Re-assert the confirmed value so a later refetch can't briefly show the
      // pre-PATCH state. No invalidate on success — that would refetch and flicker.
      qc.setQueryData<GetSessionResponse | null>(["session", sid], (prev) =>
        prev ? { ...prev, autoApprove: value } : prev,
      );
    } catch (err) {
      // Roll back the optimistic flip and re-sync from the server.
      qc.setQueryData<GetSessionResponse | null>(["session", sid], (prev) =>
        prev ? { ...prev, autoApprove: !value } : prev,
      );
      void qc.invalidateQueries({ queryKey: ["session", sid] });
      toast.error(err instanceof Error ? err.message : "Could not update auto-pilot");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-2xl bg-card p-3 text-sm shadow-xs">
      <Switch checked={autoApprove} onCheckedChange={toggle} disabled={busy || noGatesLeft} aria-label="auto-pilot" />
      <span className="font-medium">Auto-pilot</span>
      <span className="ml-auto text-xs text-muted-foreground">
        {noGatesLeft
          ? "No review points left; use Stop to halt."
          : autoApprove
            ? "Running straight to the video."
            : "Pausing at the next review point."}
      </span>
    </div>
  );
}
