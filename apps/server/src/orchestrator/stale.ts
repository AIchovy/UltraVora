import type { ArtifactKind, PhaseId } from "@ultracreator/shared";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { PhaseRegistry } from "../phases/registry.js";

/**
 * Marks every artifact downstream of `fromPhase` as stale.
 *
 * "Downstream" = phases strictly after `fromPhase` per PhaseRegistry.downstream().
 * For each kind output by a downstream phase, the latest non-stale version
 * in the repository is flagged via ArtifactStore.markStale. Older already-stale versions
 * are left alone; phases with no artifact yet are skipped.
 *
 * The target phase's own outputs are NOT touched — they remain the basis for
 * the re-run.
 */
export async function markStaleDownstream(
  store: ArtifactStore,
  registry: PhaseRegistry,
  sessionId: string,
  fromPhase: PhaseId,
): Promise<void> {
  const descriptors = await store.list(sessionId);
  const downstreamPhases = registry.downstream(fromPhase);

  const downstreamKinds: ArtifactKind[] = [];
  for (const phase of downstreamPhases) {
    downstreamKinds.push(...registry.outputs(phase));
  }

  for (const kind of downstreamKinds) {
    const versions = descriptors.filter((d) => d.kind === kind);
    if (versions.length === 0) continue;
    const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    if (latest.stale) continue;
    await store.markStale(sessionId, kind, latest.version);
  }
}
