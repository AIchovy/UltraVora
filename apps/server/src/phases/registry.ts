import type { ArtifactKind, Brief, PhaseId } from "@ultracreator/shared";

export type Gate = "user-approve";

export interface PhaseConfig {
  id: PhaseId;
  outputs: ArtifactKind[];
  gates?: Gate[];
  enabled?: (brief: Brief) => boolean;
}

export const PHASES: readonly PhaseConfig[] = [
  // Research gates so the user can curate the captured source assets (drop
  // low-quality screenshots, upload better shots) BEFORE design derives
  // keyVisuals from them — curating later leaves the design artifact
  // referencing deleted files.
  { id: "research", outputs: ["brief"], gates: ["user-approve"] },
  { id: "design", outputs: ["design"], gates: ["user-approve"] },
  { id: "script", outputs: ["script"], gates: ["user-approve"] },
  {
    id: "voiceover",
    outputs: ["narration"],
    // The narration is a paid, user-audible artifact (voice, pronunciation,
    // pacing) — pause for review instead of flowing straight into compose.
    gates: ["user-approve"],
    enabled: (brief) => brief.constraints.withVoiceover,
  },
  { id: "compose", outputs: ["composition", "music"] },
  { id: "render", outputs: ["mp4", "subtitles"] },
] as const;

export class PhaseRegistry {
  private byId = new Map<PhaseId, PhaseConfig>(PHASES.map((p) => [p.id, p]));

  getPhase(id: PhaseId): PhaseConfig {
    const p = this.byId.get(id);
    if (!p) throw new Error(`Unknown phase: ${id}`);
    return p;
  }

  outputs(id: PhaseId): ArtifactKind[] {
    return this.getPhase(id).outputs;
  }

  /** Next enabled phase after `id`, or null if there is none. */
  next(id: PhaseId, brief: Brief | null): PhaseConfig | null {
    const idx = PHASES.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`Unknown phase: ${id}`);
    for (let i = idx + 1; i < PHASES.length; i++) {
      const candidate = PHASES[i]!;
      if (this.isEnabled(candidate, brief)) return candidate;
    }
    return null;
  }

  /** Canonical predecessor (ignores enabled — user may explicitly target a disabled phase). */
  previous(id: PhaseId): PhaseConfig | null {
    const idx = PHASES.findIndex((p) => p.id === id);
    if (idx <= 0) return null;
    return PHASES[idx - 1] ?? null;
  }

  /** All phase ids strictly after `id`, in order, regardless of enabled. */
  downstream(id: PhaseId): PhaseId[] {
    const idx = PHASES.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`Unknown phase: ${id}`);
    return PHASES.slice(idx + 1).map((p) => p.id);
  }

  private isEnabled(p: PhaseConfig, brief: Brief | null): boolean {
    if (!p.enabled) return true;
    if (!brief) return false;
    return p.enabled(brief);
  }
}
