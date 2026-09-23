import { CanonicalPerception } from "@/tools/wiki/canonical-perception";
import { ShadowEvidenceAdapter } from "@/tools/wiki/evidence-adapter";
import { canonicalSemanticAddress, type SemanticAddress } from "@/tools/wiki/semantic-address";
import {
  type CanonicalRecordingTargetProvider,
  projectionFromCanonicalPerception,
} from "./semantic-target";

/**
 * The single extension-side canonical perception owner used by recording.
 * Wiki observation/reconciliation code feeds this same instance; recording
 * only reads its current, scope-gated projection.
 */
export const recordingCanonicalPerception = new CanonicalPerception(new ShadowEvidenceAdapter());

export const defaultCanonicalRecordingTargetProvider: CanonicalRecordingTargetProvider =
  projectionFromCanonicalPerception(recordingCanonicalPerception, (observation) => {
    const scope = observation.recordingScope;
    if (!scope || !observation.documentId) return undefined;
    try {
      const origin = new URL(observation.url).origin;
      const addresses = observation.index.refs().flatMap((ref) => {
        if (!ref.role && !ref.name) return [];
        const address: SemanticAddress = {
          origin,
          document: observation.documentId!,
          ...(ref.ctx ? { parentRegion: ref.ctx } : {}),
          ...(ref.role ? { role: ref.role } : {}),
          ...(ref.name ? { name: ref.name } : {}),
          ...(ref.identity?.path ? { structuralRelation: ref.identity.path } : {}),
        };
        return [{ ref, address }];
      });
      const counts = new Map<string, number>();
      for (const entry of addresses) {
        const key = canonicalSemanticAddress(entry.address);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const inputs = addresses
        .filter((entry) => counts.get(canonicalSemanticAddress(entry.address)) === 1)
        .map(({ ref, address }) => ({
          target_id:
            recordingCanonicalPerception
              .currentTargets({
                browser_id: scope.browser_id,
                session_id: scope.session_id,
                tab_id: scope.tab_id,
                document_id: observation.documentId!,
                origin,
              })
              .find(
                (target) =>
                  canonicalSemanticAddress(target.address) === canonicalSemanticAddress(address),
              )?.target_id ?? `address:${canonicalSemanticAddress(address)}`,
          address,
          stable_ref: `@${ref.ref.replace(/^@/, "")}`,
          region_id: ref.ctx ?? null,
        }));
      if (inputs.length > 0) {
        recordingCanonicalPerception.materializeRecordingObservation(
          {
            browser_id: scope.browser_id,
            session_id: scope.session_id,
            tab_id: scope.tab_id,
            document_id: observation.documentId,
            origin,
          },
          { ownership_id: `recording:${scope.session_id}` },
          inputs,
          Math.max(0, (observation.revision ?? 1) - 1),
        );
      }
      return {
        browser_id: scope.browser_id,
        session_id: scope.session_id,
        tab_id: scope.tab_id,
        document_id: observation.documentId,
        origin,
      };
    } catch {
      return undefined;
    }
  });
