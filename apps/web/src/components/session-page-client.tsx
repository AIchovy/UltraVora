"use client";
import { AppShell } from "@/components/app-shell";
import { SessionPage } from "@/components/session-page";

export function SessionPageClient({ sid }: { sid: string }): React.ReactElement {
  return (
    <AppShell creditsPlacement="floating">
      <SessionPage sid={sid} />
    </AppShell>
  );
}
