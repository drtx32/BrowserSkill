import { CanonicalPerception } from "./canonical-perception";
import { ShadowEvidenceAdapter } from "./evidence-adapter";

/** One service-worker owner for the canonical projection used by tools and recording. */
export const canonicalPerception = new CanonicalPerception(new ShadowEvidenceAdapter());
