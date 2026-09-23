import { CanonicalPerception } from "@/tools/wiki/canonical-perception";
import { ShadowEvidenceAdapter } from "@/tools/wiki/evidence-adapter";
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
      return {
        browser_id: scope.browser_id,
        session_id: scope.session_id,
        tab_id: scope.tab_id,
        document_id: observation.documentId,
        origin: new URL(observation.url).origin,
      };
    } catch {
      return undefined;
    }
  });
