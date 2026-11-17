import type { PhaseId } from "@ultracreator/shared";

export type SessionState =
  | { kind: "idle" }
  // `refinement` is set while the phase runs a user adjustment, and is
  // persisted so a crash/restart recovery re-runs the phase WITH the change
  // the user already paid for.
  | { kind: "running"; phase: PhaseId; refinement?: string }
  | { kind: "awaiting-gate"; phase: PhaseId }
  // Parked because the balance can't cover `phase`. A top-up resumes from
  // here; `refinement` preserves the user's adjustment text so the resumed
  // run still applies the requested change.
  | { kind: "awaiting-credits"; phase: PhaseId; refinement?: string }
  | { kind: "error"; phase: PhaseId; error: string }
  | { kind: "done"; lastPhase: PhaseId };
