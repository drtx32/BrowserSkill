//! Bounded, read-only retrieval over an already materialized Browser Wiki.
//!
//! This module intentionally has no store, observer, reconciler, or embedding
//! dependency. Callers provide the state they already have; a read cannot make
//! maintenance work happen as a side effect.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::wiki::{
    Claim, Completeness, PageInstance, RecordStatus, Region, SemanticDelta, WikiRef,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalSource {
    DirectRef,
    RegionTree,
    Delta,
    Lexical,
    Semantic,
    FullObserve,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalQuality {
    Exact,
    Current,
    Bounded,
    Incomplete,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct RetrievalQuery {
    pub ref_id: Option<String>,
    pub region_id: Option<String>,
    pub since_revision: Option<u64>,
    pub text: Option<String>,
    pub semantic: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WikiReadState {
    pub page_instance: PageInstance,
    #[serde(default)]
    pub regions: Vec<Region>,
    #[serde(default)]
    pub refs: Vec<WikiRef>,
    #[serde(default)]
    pub claims: Vec<Claim>,
    #[serde(default)]
    pub deltas: Vec<SemanticDelta>,
    /// Optional, pre-built local chunks. The router never creates or refreshes them.
    #[serde(default)]
    pub semantic_chunks: Vec<SemanticChunk>,
    #[serde(default)]
    pub session: Option<Value>,
    #[serde(default)]
    pub ownership: Option<Value>,
    #[serde(default)]
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SemanticChunk {
    pub chunk_id: String,
    pub text: String,
    pub revision: u64,
    #[serde(default)]
    pub evidence_event_ids: Vec<String>,
    #[serde(default)]
    pub score: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetrievalResult {
    pub kind: String,
    pub id: String,
    pub value: Value,
    pub evidence_event_ids: Vec<String>,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetrievalReceipt {
    /// A deterministic upper-bound estimate, not a tokenizer invocation.
    pub estimated_tokens: usize,
    /// The synchronous read budget. The router does not perform timing-sensitive work.
    pub latency_budget_ms: u32,
    pub result_count: usize,
    pub quality: RetrievalQuality,
    pub fallback: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetrievalEnvelope {
    pub source: RetrievalSource,
    pub page_instance_id: String,
    pub revision: u64,
    pub scope: crate::wiki::WikiScope,
    pub completeness: Completeness,
    pub results: Vec<RetrievalResult>,
    pub evidence: Vec<String>,
    pub blockers: Vec<String>,
    pub next_safe_query: Option<String>,
    pub receipt: RetrievalReceipt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompiledWikiView {
    pub page_instance_id: String,
    pub revision: u64,
    pub scope: crate::wiki::WikiScope,
    pub completeness: Completeness,
    pub claims: Vec<Claim>,
    pub active_regions: Vec<Region>,
    pub recent_deltas: Vec<SemanticDelta>,
    pub dynamic_or_incomplete_regions: Vec<String>,
    pub session: Option<Value>,
    pub ownership: Option<Value>,
    pub blockers: Vec<String>,
    pub uncertainty: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct RetrievalRouter {
    pub max_results: usize,
    pub max_tokens: usize,
    pub recent_delta_limit: usize,
}

impl Default for RetrievalRouter {
    fn default() -> Self {
        Self {
            max_results: 32,
            max_tokens: 2048,
            recent_delta_limit: 8,
        }
    }
}

impl RetrievalRouter {
    pub fn route(&self, state: &WikiReadState, query: &RetrievalQuery) -> RetrievalEnvelope {
        let max_results = self.max_results.max(1);
        let limit = query.limit.unwrap_or(max_results).min(max_results).max(1);
        if let Some(ref_id) = query.ref_id.as_deref() {
            let refs: Vec<_> = state
                .refs
                .iter()
                .filter(|r| r.ref_id == ref_id && r.lifecycle == crate::wiki::RefLifecycle::Live)
                .collect();
            if !refs.is_empty() {
                let results = refs
                    .into_iter()
                    .take(limit)
                    .map(|r| RetrievalResult {
                        kind: "ref".into(),
                        id: r.ref_id.clone(),
                        value: json!(r),
                        evidence_event_ids: vec![],
                        revision: r.last_observed_revision,
                    })
                    .collect::<Vec<_>>();
                return self.envelope(
                    state,
                    RetrievalSource::DirectRef,
                    results,
                    RetrievalQuality::Exact,
                    None,
                    None,
                );
            }
        }

        if let Some(region_id) = query.region_id.as_deref() {
            let results = self.region_results(state, Some(region_id), limit);
            if !results.is_empty() {
                return self.envelope(
                    state,
                    RetrievalSource::RegionTree,
                    results,
                    RetrievalQuality::Current,
                    None,
                    None,
                );
            }
        }

        if let Some(from) = query.since_revision {
            let results = state
                .deltas
                .iter()
                .filter(|d| d.to_revision > from)
                .take(limit)
                .map(|d| RetrievalResult {
                    kind: "delta".into(),
                    id: format!("{}:{}", d.from_revision, d.to_revision),
                    value: json!(d),
                    evidence_event_ids: vec![],
                    revision: d.to_revision,
                })
                .collect::<Vec<_>>();
            if !results.is_empty() {
                return self.envelope(
                    state,
                    RetrievalSource::Delta,
                    results,
                    RetrievalQuality::Current,
                    None,
                    None,
                );
            }
        }

        if let Some(text) = query.text.as_deref().filter(|text| !text.trim().is_empty()) {
            let needle = text.to_lowercase();
            let results = state
                .claims
                .iter()
                .filter(|claim| {
                    (is_current(&claim.status) && contains(&claim.value, &needle))
                        || (is_current(&claim.status)
                            && claim.predicate.to_lowercase().contains(&needle))
                })
                .take(limit)
                .map(|claim| RetrievalResult {
                    kind: "claim".into(),
                    id: claim.claim_id.clone(),
                    value: json!(claim),
                    evidence_event_ids: claim.evidence_event_ids.clone(),
                    revision: claim.evidence_revision,
                })
                .collect::<Vec<_>>();
            if !results.is_empty() {
                return self.envelope(
                    state,
                    RetrievalSource::Lexical,
                    results,
                    RetrievalQuality::Bounded,
                    None,
                    None,
                );
            }
            if query.semantic {
                let results = state
                    .semantic_chunks
                    .iter()
                    .filter(|chunk| contains(&Value::String(chunk.text.clone()), &needle))
                    .take(limit)
                    .map(|chunk| RetrievalResult {
                        kind: "semantic_chunk".into(),
                        id: chunk.chunk_id.clone(),
                        value: json!(chunk),
                        evidence_event_ids: chunk.evidence_event_ids.clone(),
                        revision: chunk.revision,
                    })
                    .collect::<Vec<_>>();
                if !results.is_empty() {
                    return self.envelope(
                        state,
                        RetrievalSource::Semantic,
                        results,
                        RetrievalQuality::Bounded,
                        None,
                        None,
                    );
                }
                return self.fallback(
                    state,
                    RetrievalSource::Semantic,
                    "semantic_index_unavailable",
                    "wiki.read.semantic requires an existing local index; no backfill was started",
                );
            }
        }

        if query.ref_id.is_none()
            && query.region_id.is_none()
            && query.since_revision.is_none()
            && query.text.is_none()
        {
            let results = self.region_results(state, None, limit);
            if !results.is_empty() {
                return self.envelope(
                    state,
                    RetrievalSource::RegionTree,
                    results,
                    RetrievalQuality::Current,
                    None,
                    None,
                );
            }
        }
        self.fallback(
            state,
            RetrievalSource::FullObserve,
            "insufficient_current_state",
            "fresh observe is required; retrieval never invokes observe synchronously",
        )
    }

    pub fn compile(&self, state: &WikiReadState, query: &RetrievalQuery) -> CompiledWikiView {
        let route = self.route(state, query);
        let active_regions = state
            .regions
            .iter()
            .filter(|r| r.status == RecordStatus::Active)
            .take(self.max_results)
            .cloned()
            .collect::<Vec<_>>();
        let claims = state
            .claims
            .iter()
            .filter(|c| is_current(&c.status))
            .take(self.max_results)
            .cloned()
            .collect::<Vec<_>>();
        let recent_deltas = state
            .deltas
            .iter()
            .rev()
            .take(self.recent_delta_limit)
            .cloned()
            .collect::<Vec<_>>();
        let dynamic_or_incomplete_regions = active_regions
            .iter()
            .filter(|r| r.completeness != Completeness::Complete)
            .map(|r| r.region_id.clone())
            .collect();
        let mut blockers = state.blockers.clone();
        blockers.extend(route.blockers);
        let uncertainty = claims
            .iter()
            .filter(|c| {
                c.trust == crate::wiki::TrustPlane::AgentInference
                    || c.status == RecordStatus::Uncertain
            })
            .map(|c| c.claim_id.clone())
            .collect();
        CompiledWikiView {
            page_instance_id: state.page_instance.page_instance_id.clone(),
            revision: state.page_instance.revision,
            scope: state.page_instance.scope.clone(),
            completeness: state.page_instance.completeness.clone(),
            claims,
            active_regions,
            recent_deltas,
            dynamic_or_incomplete_regions,
            session: state.session.clone(),
            ownership: state.ownership.clone(),
            blockers,
            uncertainty,
        }
    }

    fn region_results(
        &self,
        state: &WikiReadState,
        parent: Option<&str>,
        limit: usize,
    ) -> Vec<RetrievalResult> {
        state
            .regions
            .iter()
            .filter(|r| r.status == RecordStatus::Active && r.parent_region_id.as_deref() == parent)
            .take(limit)
            .map(|r| RetrievalResult {
                kind: "region".into(),
                id: r.region_id.clone(),
                value: json!(r),
                evidence_event_ids: vec![],
                revision: r.revision_last_seen,
            })
            .collect()
    }

    fn envelope(
        &self,
        state: &WikiReadState,
        source: RetrievalSource,
        results: Vec<RetrievalResult>,
        quality: RetrievalQuality,
        fallback: Option<String>,
        next: Option<String>,
    ) -> RetrievalEnvelope {
        let result_count = results.len();
        let estimated_tokens = results
            .iter()
            .map(|r| {
                serde_json::to_string(&r.value)
                    .map(|s| s.len().div_ceil(4))
                    .unwrap_or(0)
            })
            .sum::<usize>()
            .min(self.max_tokens);
        let evidence = results
            .iter()
            .flat_map(|r| r.evidence_event_ids.clone())
            .take(self.max_results.max(1))
            .collect();
        let mut blockers = state.blockers.clone();
        if state.page_instance.completeness != Completeness::Complete {
            blockers
                .push(format!("wiki_state_{:?}", state.page_instance.completeness).to_lowercase());
        }
        RetrievalEnvelope {
            source,
            page_instance_id: state.page_instance.page_instance_id.clone(),
            revision: state.page_instance.revision,
            scope: state.page_instance.scope.clone(),
            completeness: state.page_instance.completeness.clone(),
            results,
            evidence,
            blockers,
            next_safe_query: next,
            receipt: RetrievalReceipt {
                estimated_tokens,
                latency_budget_ms: 25,
                result_count,
                quality,
                fallback,
            },
        }
    }

    fn fallback(
        &self,
        state: &WikiReadState,
        attempted: RetrievalSource,
        reason: &str,
        message: &str,
    ) -> RetrievalEnvelope {
        let mut envelope = self.envelope(
            state,
            RetrievalSource::FullObserve,
            vec![],
            RetrievalQuality::Unavailable,
            Some(format!("{}:{:?}", reason, attempted)),
            Some("observe current page, then retry the same bounded query".into()),
        );
        let mut blockers = envelope.blockers;
        blockers.push(message.into());
        envelope.blockers = blockers;
        envelope
    }
}

fn contains(value: &Value, needle: &str) -> bool {
    value.to_string().to_lowercase().contains(needle)
}

fn is_current(status: &RecordStatus) -> bool {
    matches!(status, RecordStatus::Active | RecordStatus::Current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wiki::{Provenance, ProvenanceKind, RefLifecycle, RegionKind, TrustPlane};

    fn state() -> WikiReadState {
        let page_instance: PageInstance =
            serde_json::from_str(include_str!("../fixtures/wiki/page-instance.json")).unwrap();
        WikiReadState {
            page_instance,
            regions: vec![
                Region {
                    schema_version: "1.0".into(),
                    region_id: "region-root".into(),
                    page_instance_id: "page-1".into(),
                    parent_region_id: None,
                    kind: RegionKind::Content,
                    locator: None,
                    bounds: None,
                    revision_first_seen: 12,
                    revision_last_seen: 12,
                    status: RecordStatus::Active,
                    completeness: Completeness::Complete,
                },
                Region {
                    schema_version: "1.0".into(),
                    region_id: "region-list".into(),
                    page_instance_id: "page-1".into(),
                    parent_region_id: Some("region-root".into()),
                    kind: RegionKind::List,
                    locator: Some("inbox-list".into()),
                    bounds: None,
                    revision_first_seen: 12,
                    revision_last_seen: 12,
                    status: RecordStatus::Active,
                    completeness: Completeness::Complete,
                },
            ],
            refs: vec![WikiRef {
                schema_version: "1.0".into(),
                ref_id: "@e1".into(),
                page_instance_id: "page-1".into(),
                region_id: Some("region-root".into()),
                interaction_kind: "click".into(),
                lifecycle: RefLifecycle::Live,
                last_observed_revision: 12,
            }],
            claims: vec![Claim {
                schema_version: "1.0".into(),
                claim_id: "claim-inbox".into(),
                subject_id: "region-root".into(),
                predicate: "label".into(),
                value: serde_json::json!("Inbox"),
                trust: TrustPlane::GroundTruth,
                status: RecordStatus::Current,
                evidence_event_ids: vec!["event-1".into()],
                evidence_revision: 12,
                last_verified_revision: Some(12),
                confidence: Some(1.0),
                provenance: Provenance {
                    kind: ProvenanceKind::Observed,
                    author: "test".into(),
                    evidence_event_ids: vec!["event-1".into()],
                },
                valid_from_revision: 12,
                valid_until_revision: None,
            }],
            deltas: vec![
                serde_json::from_str(include_str!("../fixtures/wiki/delta-full-refresh.json"))
                    .unwrap(),
            ],
            semantic_chunks: vec![SemanticChunk {
                chunk_id: "chunk-archive".into(),
                text: "Archive the selected inbox message".into(),
                revision: 12,
                evidence_event_ids: vec!["event-2".into()],
                score: Some(0.9),
            }],
            session: Some(serde_json::json!({"id": "session-1"})),
            ownership: Some(serde_json::json!({"owned": true})),
            blockers: vec![],
        }
    }

    #[test]
    fn routes_in_contract_order_before_falling_back() {
        let router = RetrievalRouter::default();
        let state = state();
        assert_eq!(
            router
                .route(
                    &state,
                    &RetrievalQuery {
                        ref_id: Some("@e1".into()),
                        ..Default::default()
                    }
                )
                .source,
            RetrievalSource::DirectRef
        );
        assert_eq!(
            router
                .route(
                    &state,
                    &RetrievalQuery {
                        region_id: Some("region-root".into()),
                        ..Default::default()
                    }
                )
                .source,
            RetrievalSource::RegionTree
        );
        assert_eq!(
            router
                .route(
                    &state,
                    &RetrievalQuery {
                        since_revision: Some(12),
                        ..Default::default()
                    }
                )
                .source,
            RetrievalSource::Delta
        );
        assert_eq!(
            router
                .route(
                    &state,
                    &RetrievalQuery {
                        text: Some("inbox".into()),
                        ..Default::default()
                    }
                )
                .source,
            RetrievalSource::Lexical
        );
        assert_eq!(
            router
                .route(
                    &state,
                    &RetrievalQuery {
                        text: Some("archive".into()),
                        semantic: true,
                        ..Default::default()
                    }
                )
                .source,
            RetrievalSource::Semantic
        );
        assert_eq!(
            router
                .route(
                    &state,
                    &RetrievalQuery {
                        text: Some("unknown".into()),
                        semantic: true,
                        ..Default::default()
                    }
                )
                .source,
            RetrievalSource::FullObserve
        );
    }

    #[test]
    fn semantic_fallback_does_not_backfill_or_mutate_state() {
        let router = RetrievalRouter::default();
        let mut state = state();
        state.semantic_chunks.clear();
        let before = state.semantic_chunks.len();
        let result = router.route(
            &state,
            &RetrievalQuery {
                text: Some("unknown".into()),
                semantic: true,
                ..Default::default()
            },
        );
        assert_eq!(
            result.receipt.fallback.as_deref(),
            Some("semantic_index_unavailable:Semantic")
        );
        assert!(
            result
                .blockers
                .iter()
                .any(|blocker| blocker.contains("no backfill"))
        );
        assert_eq!(state.semantic_chunks.len(), before);
    }

    #[test]
    fn receipt_is_bounded_and_reports_quality_and_latency_budget() {
        let router = RetrievalRouter {
            max_results: 1,
            max_tokens: 1,
            recent_delta_limit: 1,
        };
        let result = router.route(
            &state(),
            &RetrievalQuery {
                text: Some("inbox".into()),
                limit: Some(10),
                ..Default::default()
            },
        );
        assert_eq!(result.results.len(), 1);
        assert!(result.receipt.estimated_tokens <= 1);
        assert_eq!(result.receipt.result_count, 1);
        assert_eq!(result.receipt.quality, RetrievalQuality::Bounded);
        assert_eq!(result.receipt.latency_budget_ms, 25);
    }

    #[test]
    fn compiled_view_surfaces_incompleteness_and_blockers() {
        let mut state = state();
        state.page_instance.completeness = Completeness::FullRefreshRequired;
        state.regions[1].completeness = Completeness::Partial;
        state.blockers.push("ownership_missing".into());
        let view = RetrievalRouter::default().compile(&state, &RetrievalQuery::default());
        assert_eq!(view.completeness, Completeness::FullRefreshRequired);
        assert_eq!(view.dynamic_or_incomplete_regions, vec!["region-list"]);
        assert!(
            view.blockers
                .iter()
                .any(|blocker| blocker == "ownership_missing")
        );
        assert!(
            view.blockers
                .iter()
                .any(|blocker| blocker.contains("fullrefreshrequired"))
        );
        assert_eq!(view.session, Some(serde_json::json!({"id": "session-1"})));
        assert_eq!(view.ownership, Some(serde_json::json!({"owned": true})));
    }
}
