import { CanonicalPerception } from "./canonical-perception";
import { ShadowEvidenceAdapter } from "./evidence-adapter";

/** Shared ELI-304/307 Page-Wiki projection; recording is one consumer only. */
export const canonicalPerception = new CanonicalPerception(new ShadowEvidenceAdapter());
