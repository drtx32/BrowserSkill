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
    /// An explicitly materialized, local-only semantic index. Retrieval never
    /// constructs or refreshes this value.
    #[serde(default)]
    pub semantic_index: Option<LocalSemanticIndex>,
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
    /// Stable semantic region identity; DOM nodes are intentionally not index
    /// entries.
    #[serde(default)]
    pub region_id: Option<String>,
    #[serde(default)]
    pub evidence_event_ids: Vec<String>,
    #[serde(default)]
    pub score: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalSemanticIndex {
    pub page_instance_id: String,
    pub scope: crate::wiki::WikiScope,
    pub source_revision: u64,
    #[serde(default)]
    pub chunks: Vec<SemanticChunk>,
}

impl LocalSemanticIndex {
    /// Build an index from stable region/chunk records. This is an explicit
    /// maintenance operation; the retrieval router never calls it.
    pub fn build(page: &PageInstance, chunks: impl IntoIterator<Item = SemanticChunk>) -> Self {
        Self {
            page_instance_id: page.page_instance_id.clone(),
            scope: page.scope.clone(),
            source_revision: page.revision,
            chunks: chunks
                .into_iter()
                .filter(|chunk| chunk.region_id.is_some())
                .collect(),
        }
    }
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
    /// Index health is explicit so stale results can never look like a
    /// healthy empty response.
    #[serde(default)]
    pub index_status: Option<String>,
    #[serde(default)]
    pub index_source_revision: Option<u64>,
    #[serde(default)]
    pub current_revision: u64,
    #[serde(default)]
    pub last_safe_revision: Option<u64>,
}

#[derive(Debug, Clone, Default)]
struct IndexReceipt {
    status: Option<String>,
    source_revision: Option<u64>,
    last_safe_revision: Option<u64>,
}

#[derive(Debug, Clone, Default)]
struct EnvelopeOptions {
    fallback: Option<String>,
    next: Option<String>,
    index: IndexReceipt,
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
    pub source: RetrievalSource,
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
    pub receipt: RetrievalReceipt,
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
                let (chunks, index_status, source_revision, last_safe_revision) =
                    self.semantic_candidates(state);
                let index = IndexReceipt {
                    status: index_status,
                    source_revision,
                    last_safe_revision,
                };
                let results = chunks
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
                    return self.envelope_with_options(
                        state,
                        RetrievalSource::Semantic,
                        results,
                        RetrievalQuality::Bounded,
                        EnvelopeOptions {
                            index: index.clone(),
                            ..Default::default()
                        },
                    );
                }
                if index.status.as_deref() == Some("stale_index") {
                    return self.fallback_with_index(
                        state,
                        "stale_index",
                        "local semantic index revision/scope does not match canonical state; no backfill was started",
                        index,
                    );
                }
                if index.status.as_deref() == Some("index_not_built") {
                    return self.fallback_with_index(
                        state,
                        "index_not_built",
                        "wiki.read.semantic requires an existing local index; no backfill was started",
                        index,
                    );
                }
                return self.envelope_with_options(
                    state,
                    RetrievalSource::FullObserve,
                    vec![],
                    RetrievalQuality::Bounded,
                    EnvelopeOptions {
                        fallback: Some("healthy_no_match".into()),
                        index,
                        ..Default::default()
                    },
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
            "insufficient_current_state",
            "fresh observe is required; retrieval never invokes observe synchronously",
        )
    }

    pub fn compile(&self, state: &WikiReadState, query: &RetrievalQuery) -> CompiledWikiView {
        let route = self.route(state, query);
        let source = route.source;
        let receipt = route.receipt.clone();
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
            source,
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
            receipt,
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
        self.envelope_with_options(
            state,
            source,
            results,
            quality,
            EnvelopeOptions {
                fallback,
                next,
                ..Default::default()
            },
        )
    }

    fn envelope_with_options(
        &self,
        state: &WikiReadState,
        source: RetrievalSource,
        results: Vec<RetrievalResult>,
        quality: RetrievalQuality,
        options: EnvelopeOptions,
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
            if state.page_instance.completeness == Completeness::FullRefreshRequired {
                blockers.push("full_refresh_required".into());
            }
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
            next_safe_query: options.next,
            receipt: RetrievalReceipt {
                estimated_tokens,
                latency_budget_ms: 25,
                result_count,
                quality,
                fallback: options.fallback,
                index_status: options.index.status,
                index_source_revision: options.index.source_revision,
                current_revision: state.page_instance.revision,
                last_safe_revision: options.index.last_safe_revision,
            },
        }
    }

    fn fallback(&self, state: &WikiReadState, reason: &str, message: &str) -> RetrievalEnvelope {
        self.fallback_with_index(state, reason, message, IndexReceipt::default())
    }

    fn fallback_with_index(
        &self,
        state: &WikiReadState,
        reason: &str,
        message: &str,
        index: IndexReceipt,
    ) -> RetrievalEnvelope {
        let mut envelope = self.envelope_with_options(
            state,
            RetrievalSource::FullObserve,
            vec![],
            RetrievalQuality::Unavailable,
            EnvelopeOptions {
                fallback: Some(reason.into()),
                next: Some("observe current page, then retry the same bounded query".into()),
                index,
            },
        );
        let mut blockers = envelope.blockers;
        blockers.push(message.into());
        if reason == "stale_index" {
            blockers.push("index-drift".into());
        }
        if reason == "insufficient_current_state" {
            blockers.push("unavailable".into());
        }
        envelope.blockers = blockers;
        envelope
    }

    fn semantic_candidates(
        &self,
        state: &WikiReadState,
    ) -> (Vec<SemanticChunk>, Option<String>, Option<u64>, Option<u64>) {
        let Some(index) = state.semantic_index.as_ref() else {
            // Keep the pre-index field as a compatibility envelope for older
            // callers, but still classify it rather than treating it as an
            // implicit rebuild request.
            if state.semantic_chunks.is_empty() {
                return (vec![], Some("index_not_built".into()), None, None);
            }
            let current = state.page_instance.revision;
            let stale = state
                .semantic_chunks
                .iter()
                .any(|chunk| chunk.revision != current);
            let source_revision = state
                .semantic_chunks
                .iter()
                .map(|chunk| chunk.revision)
                .min()
                .unwrap_or(current);
            return (
                if stale {
                    vec![]
                } else {
                    state.semantic_chunks.clone()
                },
                Some(if stale { "stale_index" } else { "ready" }.into()),
                Some(source_revision),
                Some(if stale { source_revision } else { current }),
            );
        };
        let current = state.page_instance.revision;
        let scope_matches = index.page_instance_id == state.page_instance.page_instance_id
            && index.scope == state.page_instance.scope;
        let chunks_match = index
            .chunks
            .iter()
            .all(|chunk| chunk.revision == index.source_revision);
        let chunks = index
            .chunks
            .iter()
            .filter(|chunk| chunk.region_id.is_some())
            .cloned()
            .collect();
        let stale = !scope_matches || index.source_revision != current || !chunks_match;
        (
            if stale { vec![] } else { chunks },
            Some(if stale { "stale_index" } else { "ready" }.into()),
            Some(index.source_revision),
            Some(if stale {
                index.source_revision.min(current)
            } else {
                current
            }),
        )
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
                region_id: Some("region-list".into()),
                evidence_event_ids: vec!["event-2".into()],
                score: Some(0.9),
            }],
            semantic_index: None,
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
        assert_eq!(result.receipt.fallback.as_deref(), Some("index_not_built"));
        assert!(
            result
                .blockers
                .iter()
                .any(|blocker| blocker.contains("no backfill"))
        );
        assert_eq!(state.semantic_chunks.len(), before);
    }

    #[test]
    fn distinguishes_not_built_from_healthy_empty_and_stale_index() {
        let router = RetrievalRouter::default();
        let mut state = state();
        state.semantic_chunks.clear();
        let not_built = router.route(
            &state,
            &RetrievalQuery {
                text: Some("missing".into()),
                semantic: true,
                ..Default::default()
            },
        );
        assert_eq!(
            not_built.receipt.fallback.as_deref(),
            Some("index_not_built")
        );
        assert_eq!(
            not_built.receipt.index_status.as_deref(),
            Some("index_not_built")
        );
        assert_eq!(not_built.receipt.last_safe_revision, None);

        let page = state.page_instance.clone();
        state.semantic_index = Some(LocalSemanticIndex::build(
            &page,
            [SemanticChunk {
                chunk_id: "chunk-1".into(),
                text: "Inbox archive".into(),
                revision: page.revision,
                region_id: Some("region-root".into()),
                evidence_event_ids: vec![],
                score: None,
            }],
        ));
        let healthy_empty = router.route(
            &state,
            &RetrievalQuery {
                text: Some("not-present".into()),
                semantic: true,
                ..Default::default()
            },
        );
        assert_eq!(
            healthy_empty.receipt.fallback.as_deref(),
            Some("healthy_no_match")
        );
        assert_eq!(healthy_empty.receipt.index_status.as_deref(), Some("ready"));
        assert_eq!(healthy_empty.receipt.quality, RetrievalQuality::Bounded);

        state.page_instance.revision += 1;
        let stale = router.route(
            &state,
            &RetrievalQuery {
                text: Some("archive".into()),
                semantic: true,
                ..Default::default()
            },
        );
        assert_eq!(stale.receipt.fallback.as_deref(), Some("stale_index"));
        assert_eq!(stale.receipt.index_status.as_deref(), Some("stale_index"));
        assert_eq!(stale.receipt.index_source_revision, Some(page.revision));
        assert_eq!(stale.receipt.current_revision, page.revision + 1);
        assert_eq!(stale.receipt.last_safe_revision, Some(page.revision));
        assert!(stale.results.is_empty());
    }

    #[test]
    fn local_index_only_accepts_region_chunks_and_is_scope_bound() {
        let state = state();
        let index = LocalSemanticIndex::build(
            &state.page_instance,
            [
                SemanticChunk {
                    chunk_id: "region-chunk".into(),
                    text: "stable region".into(),
                    revision: state.page_instance.revision,
                    region_id: Some("region-root".into()),
                    evidence_event_ids: vec![],
                    score: None,
                },
                SemanticChunk {
                    chunk_id: "dom-node".into(),
                    text: "must not be indexed".into(),
                    revision: state.page_instance.revision,
                    region_id: None,
                    evidence_event_ids: vec![],
                    score: None,
                },
            ],
        );
        assert_eq!(index.chunks.len(), 1);
        assert_eq!(index.chunks[0].region_id.as_deref(), Some("region-root"));
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
