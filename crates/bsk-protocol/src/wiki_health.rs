//! Deterministic, read-only health metrics for the Stage 4 Wiki.
//!
//! Eligibility is deliberately supplied by the evaluation snapshot.  The
//! calculator never derives a denominator from the current status of a record;
//! retiring a claim can therefore not make health look better by removing it.

use crate::wiki::{Claim, Completeness, RecordStatus, Relation, RelationType, Region, SemanticDelta};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FrozenEligibility {
    pub region_ids: Vec<String>,
    pub claim_ids: Vec<String>,
    pub relation_types: Vec<RelationType>,
    pub delta_ids: Vec<String>,
    pub frontier_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FrontierSample {
    pub frontier_id: String,
    pub item_ids: Vec<String>,
    pub last_complete_revision: Option<u64>,
    pub evidence_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HealthMetric {
    pub numerator: usize,
    pub denominator: usize,
    pub rate: f64,
    pub sample_ids: Vec<String>,
    pub evidence_revision: u64,
    pub formula: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WikiHealthReport {
    pub schema_version: String,
    pub eligibility: FrozenEligibility,
    pub semantic_orphan_rate: HealthMetric,
    pub relation_link_coverage: HealthMetric,
    pub stale_claim_rate: HealthMetric,
    pub delta_completeness_rate: HealthMetric,
    pub full_refresh_rate: HealthMetric,
    pub virtual_frontier_resumability_rate: HealthMetric,
    pub virtual_frontier_duplicate_rate: HealthMetric,
}

fn rate(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 { 0.0 } else { numerator as f64 / denominator as f64 }
}

fn metric(numerator: usize, denominator: usize, sample_ids: Vec<String>, revision: u64, formula: &str) -> HealthMetric {
    HealthMetric { numerator, denominator, rate: rate(numerator, denominator), sample_ids, evidence_revision: revision, formula: formula.into() }
}

fn ids(values: &[String]) -> BTreeSet<&str> { values.iter().map(String::as_str).collect() }

/// Compute all health metrics from one immutable evidence snapshot.
pub fn compute_health(
    eligibility: FrozenEligibility,
    regions: &[Region],
    claims: &[Claim],
    relations: &[Relation],
    deltas: &[(String, SemanticDelta)],
    frontiers: &[FrontierSample],
    evidence_revision: u64,
) -> WikiHealthReport {
    let region_ids = ids(&eligibility.region_ids);
    let claim_ids = ids(&eligibility.claim_ids);
    let frontier_ids = ids(&eligibility.frontier_ids);
    let eligible_region_count = eligibility.region_ids.len();
    let eligible_claim_count = eligibility.claim_ids.len();
    let expected_relation_count = eligibility.relation_types.len();
    let eligible_delta_count = eligibility.delta_ids.len();
    let eligible_frontier_count = eligibility.frontier_ids.len();
    let eligible_regions: Vec<&Region> = regions.iter().filter(|r| region_ids.contains(r.region_id.as_str())).collect();
    let eligible_claims: Vec<&Claim> = claims.iter().filter(|c| claim_ids.contains(c.claim_id.as_str())).collect();
    let valid_relation = |r: &&Relation| {
        eligibility.relation_types.contains(&r.relation_type)
            && r.status == RecordStatus::Current
            && !r.evidence_event_ids.is_empty()
            && (region_ids.contains(r.from_id.as_str()) || claim_ids.contains(r.from_id.as_str()))
            && (region_ids.contains(r.to_id.as_str()) || claim_ids.contains(r.to_id.as_str()))
    };
    let relation_types: Vec<RelationType> = relations
        .iter()
        .filter(valid_relation)
        .map(|r| r.relation_type.clone())
        .fold(Vec::new(), |mut types, relation_type| {
            if !types.contains(&relation_type) {
                types.push(relation_type);
            }
            types
        });
    let orphan_ids: Vec<String> = eligible_regions.iter().filter(|r| {
        let evidence = r.revision_last_seen <= evidence_revision;
        let parent = r.parent_region_id.as_ref().map(|p| region_ids.contains(p.as_str())).unwrap_or(false);
        let linked = relations.iter().any(|rel| valid_relation(&rel) && rel.to_id == r.region_id);
        r.status != RecordStatus::Active || !(evidence && (parent || linked))
    }).map(|r| r.region_id.clone()).collect();
    let stale_ids: Vec<String> = eligible_claims.iter().filter(|c| matches!(c.status, RecordStatus::Stale | RecordStatus::Superseded | RecordStatus::Uncertain)).map(|c| c.claim_id.clone()).collect();
    let eligible_deltas: Vec<&(String, SemanticDelta)> = deltas.iter().filter(|(id, _)| eligibility.delta_ids.iter().any(|wanted| wanted == id)).collect();
    let complete_ids: Vec<String> = eligible_deltas.iter().filter(|(_, d)| d.completeness == Completeness::Complete).map(|(id, _)| (*id).clone()).collect();
    let refresh_ids: Vec<String> = eligible_deltas.iter().filter(|(_, d)| d.completeness == Completeness::FullRefreshRequired).map(|(id, _)| (*id).clone()).collect();
    let eligible_frontiers: Vec<&FrontierSample> = frontiers.iter().filter(|f| frontier_ids.contains(f.frontier_id.as_str())).collect();
    let resumable_ids: Vec<String> = eligible_frontiers.iter().filter(|f| f.last_complete_revision.is_some_and(|r| r <= f.evidence_revision)).map(|f| f.frontier_id.clone()).collect();
    let duplicate_ids: Vec<String> = eligible_frontiers.iter().flat_map(|f| {
        let unique = f.item_ids.iter().collect::<BTreeSet<_>>().len();
        if unique < f.item_ids.len() { Some(f.frontier_id.clone()) } else { None }
    }).collect();
    WikiHealthReport {
        schema_version: crate::wiki::WIKI_SCHEMA_VERSION.into(),
        eligibility,
        semantic_orphan_rate: metric(orphan_ids.len(), eligible_region_count, orphan_ids, evidence_revision, "orphaned eligible regions / frozen eligible regions"),
        relation_link_coverage: metric(relation_types.len(), expected_relation_count, relation_types.iter().map(|t| format!("relation:{t:?}")).collect(), evidence_revision, "relation types with current endpoints and evidence / frozen expected relation types"),
        stale_claim_rate: metric(stale_ids.len(), eligible_claim_count, stale_ids, evidence_revision, "stale|superseded|uncertain eligible claims / frozen eligible claims"),
        delta_completeness_rate: metric(complete_ids.len(), eligible_delta_count, complete_ids, evidence_revision, "complete eligible deltas / frozen eligible deltas"),
        full_refresh_rate: metric(refresh_ids.len(), eligible_delta_count, refresh_ids, evidence_revision, "full_refresh_required eligible deltas / frozen eligible deltas"),
        virtual_frontier_resumability_rate: metric(resumable_ids.len(), eligible_frontier_count, resumable_ids, evidence_revision, "resumable eligible frontiers / frozen eligible frontiers"),
        virtual_frontier_duplicate_rate: metric(duplicate_ids.len(), eligible_frontier_count, duplicate_ids, evidence_revision, "frontiers containing duplicate item IDs / frozen eligible frontiers"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wiki::{Provenance, ProvenanceKind, TrustPlane};
    use serde_json::json;

    fn claim(id: &str, status: RecordStatus) -> Claim {
        Claim {
            schema_version: "1.0".into(),
            claim_id: id.into(),
            subject_id: "r1".into(),
            predicate: "label".into(),
            value: json!(id),
            trust: TrustPlane::Derived,
            status,
            evidence_event_ids: vec!["e1".into()],
            evidence_revision: 2,
            last_verified_revision: Some(2),
            confidence: None,
            provenance: Provenance {
                kind: ProvenanceKind::Observed,
                author: "fixture".into(),
                evidence_event_ids: vec!["e1".into()],
            },
            valid_from_revision: 0,
            valid_until_revision: None,
        }
    }

    #[test]
    fn frozen_claim_denominator_survives_retirement() {
        let eligibility = FrozenEligibility {
            region_ids: vec![],
            claim_ids: vec!["c1".into(), "c2".into()],
            relation_types: vec![],
            delta_ids: vec![],
            frontier_ids: vec![],
        };
        let before = compute_health(
            eligibility.clone(),
            &[],
            &[
                claim("c1", RecordStatus::Current),
                claim("c2", RecordStatus::Stale),
            ],
            &[],
            &[],
            &[],
            2,
        );
        let after = compute_health(
            eligibility,
            &[],
            &[
                claim("c1", RecordStatus::Current),
                claim("c2", RecordStatus::Invalidated),
            ],
            &[],
            &[],
            &[],
            2,
        );
        assert_eq!(before.stale_claim_rate.denominator, 2);
        assert_eq!(after.stale_claim_rate.denominator, 2);
        assert_eq!(after.stale_claim_rate.rate, 0.0);
    }

    #[test]
    fn empty_denominators_are_explicit_zero_not_nan() {
        let r = compute_health(
            FrozenEligibility {
                region_ids: vec![],
                claim_ids: vec![],
                relation_types: vec![],
                delta_ids: vec![],
                frontier_ids: vec![],
            },
            &[],
            &[],
            &[],
            &[],
            &[],
            7,
        );
        assert_eq!(r.stale_claim_rate.rate, 0.0);
        assert_eq!(r.stale_claim_rate.evidence_revision, 7);
    }
}
