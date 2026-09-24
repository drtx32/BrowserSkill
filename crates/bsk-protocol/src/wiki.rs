//! Stage 4 Browser Wiki ABI.
//!
//! These records are deliberately additive. `WikiRef::ref_id` is the existing
//! session-scoped interaction ref; the wiki never creates an action identity.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const WIKI_SCHEMA_VERSION: &str = "1.0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WikiScope {
    pub browser_id: String,
    pub session_id: String,
    pub tab_id: i64,
    pub document_id: String,
    pub origin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Completeness {
    Complete,
    Partial,
    Stale,
    Unknown,
    Overflow,
    Ambiguous,
    FullRefreshRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecordStatus {
    Active,
    Removed,
    Current,
    Stale,
    Superseded,
    Uncertain,
    Invalidated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PageInstance {
    pub schema_version: String,
    pub page_instance_id: String,
    pub scope: WikiScope,
    pub url: Option<String>,
    pub title: Option<String>,
    pub navigation_epoch: u64,
    pub revision: u64,
    pub completeness: Completeness,
    pub active: bool,
    pub invalidated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RegionKind {
    Landmark,
    Form,
    List,
    ListItem,
    Dialog,
    Table,
    Content,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Region {
    pub schema_version: String,
    pub region_id: String,
    pub page_instance_id: String,
    pub parent_region_id: Option<String>,
    pub kind: RegionKind,
    /// Existing semantic/stable identity only; never a new clickable ref.
    pub locator: Option<String>,
    pub bounds: Option<Bounds>,
    pub revision_first_seen: u64,
    pub revision_last_seen: u64,
    pub status: RecordStatus,
    pub completeness: Completeness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RefLifecycle {
    Live,
    Stale,
    Invalidated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WikiRef {
    pub schema_version: String,
    /// Existing `@e<N>` session ref or its canonical stable-ref value.
    pub ref_id: String,
    pub page_instance_id: String,
    pub region_id: Option<String>,
    pub interaction_kind: String,
    pub lifecycle: RefLifecycle,
    pub last_observed_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Observation,
    Mutation,
    Navigation,
    Action,
    Popup,
    Ownership,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    Dom,
    Ax,
    Cdp,
    Vom,
    Daemon,
    Cli,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WikiEvent {
    pub schema_version: String,
    pub event_id: String,
    pub page_instance_id: String,
    pub revision: u64,
    pub kind: EventKind,
    pub source: EventSource,
    /// Bounded and locally redacted by the producer; not an authorization input.
    pub payload: Value,
    pub predecessor_event_id: Option<String>,
    pub completeness: Completeness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TrustPlane {
    GroundTruth,
    Derived,
    AgentInference,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceKind {
    Observed,
    Reconciled,
    Annotated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Provenance {
    pub kind: ProvenanceKind,
    pub author: String,
    pub evidence_event_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Claim {
    pub schema_version: String,
    pub claim_id: String,
    pub subject_id: String,
    pub predicate: String,
    pub value: Value,
    pub trust: TrustPlane,
    pub status: RecordStatus,
    pub evidence_event_ids: Vec<String>,
    pub evidence_revision: u64,
    pub last_verified_revision: Option<u64>,
    pub confidence: Option<f64>,
    pub provenance: Provenance,
    pub valid_from_revision: u64,
    pub valid_until_revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RelationType {
    Contains,
    Labels,
    Controls,
    Opens,
    Caused,
    References,
    ItemOf,
    OwnedBy,
    Blocks,
    LinkedTo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Relation {
    pub schema_version: String,
    pub relation_id: String,
    pub relation_type: RelationType,
    pub from_id: String,
    pub to_id: String,
    pub evidence_event_ids: Vec<String>,
    pub status: RecordStatus,
    pub scope: WikiScope,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ChangedRecord {
    pub before: Value,
    pub after: Value,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SemanticDelta {
    pub schema_version: String,
    pub page_instance_id: String,
    pub from_revision: u64,
    pub to_revision: u64,
    pub added: Vec<Value>,
    pub changed: Vec<ChangedRecord>,
    pub removed: Vec<String>,
    pub dirty_regions: Vec<String>,
    pub completeness: Completeness,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WikiCapability {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WikiCapabilities {
    pub schema_version: String,
    pub min_compatible_schema: String,
    pub capabilities: Vec<WikiCapability>,
}

/// A page-specific read request. The complete scope is mandatory so a
/// historical page cannot be used as an unscoped evidence index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WikiPageReadParams {
    pub page_instance_id: String,
    pub scope: WikiScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WikiDeltaParams {
    pub page_instance_id: String,
    pub scope: WikiScope,
    pub from_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Invalidation {
    pub reason: String,
    pub page_instance_id: String,
    pub last_safe_revision: u64,
    pub action_refs_invalidated: bool,
    pub requires_full_refresh: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_keeps_document_and_session_boundaries_explicit() {
        let scope = WikiScope {
            browser_id: "b".into(),
            session_id: "s".into(),
            tab_id: 1,
            document_id: "d".into(),
            origin: "https://example.test".into(),
        };
        let json = serde_json::to_value(&scope).unwrap();
        assert_eq!(json["document_id"], "d");
        assert_eq!(json["session_id"], "s");
    }

    #[test]
    fn agent_inference_is_not_ground_truth() {
        let claim = Claim {
            schema_version: WIKI_SCHEMA_VERSION.into(),
            claim_id: "c".into(),
            subject_id: "p".into(),
            predicate: "label".into(),
            value: Value::String("x".into()),
            trust: TrustPlane::AgentInference,
            status: RecordStatus::Uncertain,
            evidence_event_ids: vec!["e".into()],
            evidence_revision: 2,
            last_verified_revision: None,
            confidence: Some(0.5),
            provenance: Provenance {
                kind: ProvenanceKind::Annotated,
                author: "agent".into(),
                evidence_event_ids: vec!["e".into()],
            },
            valid_from_revision: 2,
            valid_until_revision: None,
        };
        assert_eq!(claim.trust, TrustPlane::AgentInference);
        assert_ne!(claim.trust, TrustPlane::GroundTruth);
    }

    #[test]
    fn conformance_fixtures_deserialize() {
        let page: PageInstance =
            serde_json::from_str(include_str!("../fixtures/wiki/page-instance.json")).unwrap();
        let delta: SemanticDelta =
            serde_json::from_str(include_str!("../fixtures/wiki/delta-full-refresh.json")).unwrap();
        let claim: Claim =
            serde_json::from_str(include_str!("../fixtures/wiki/claim-agent-inference.json"))
                .unwrap();
        let capabilities: WikiCapabilities =
            serde_json::from_str(include_str!("../fixtures/wiki/capabilities.json")).unwrap();
        assert_eq!(page.revision, 12);
        assert_eq!(delta.completeness, Completeness::FullRefreshRequired);
        assert_eq!(claim.trust, TrustPlane::AgentInference);
        assert_eq!(capabilities.min_compatible_schema, WIKI_SCHEMA_VERSION);
    }
}
