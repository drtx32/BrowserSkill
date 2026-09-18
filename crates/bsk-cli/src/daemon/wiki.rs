//! Read-only shadow Browser Wiki persistence.
//!
//! This store is deliberately not part of tool authorization.  It records a
//! bounded, local evidence stream beside the existing observe/action path.
//! The append protocol uses a marker plus atomic replacement so a crash can
//! only make the next read conservative (`full_refresh_required`).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{Context, Result, bail};
use bsk_protocol::{ChangedRecord, Completeness, EventSource, PageInstance, SemanticDelta, WikiEvent,
    WikiScope, WIKI_SCHEMA_VERSION};
use bsk_protocol::wiki::EventKind as WikiEventKind;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

pub const MAX_EVENT_PAYLOAD_BYTES: usize = 64 * 1024;
pub const MAX_EVENTS_PER_PAGE: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedPage {
    page: PageInstance,
    events: Vec<WikiEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PersistedStore {
    pages: HashMap<String, PersistedPage>,
}

#[derive(Debug)]
pub struct ShadowWikiStore {
    root: Option<PathBuf>,
    state: Mutex<PersistedStore>,
    load_failed: bool,
}

impl ShadowWikiStore {
    pub fn new(root: Option<PathBuf>) -> Self {
        let mut store = Self { root, state: Mutex::new(PersistedStore::default()), load_failed: false };
        if store.load().is_err() { store.load_failed = true; }
        store
    }

    pub fn page(&self, page_id: &str) -> Option<PageInstance> {
        self.state.lock().ok()?.pages.get(page_id).map(|p| p.page.clone())
    }

    /// Return one page only after the caller has supplied its exact scope.
    pub fn scoped_page(&self, page_id: &str, scope: &WikiScope) -> Option<PageInstance> {
        self.state.lock().ok()?.pages.get(page_id)
            .filter(|page| &page.page.scope == scope)
            .map(|page| page.page.clone())
    }

    pub fn scoped_events(&self, page_id: &str, scope: &WikiScope) -> Option<Vec<WikiEvent>> {
        self.state.lock().ok()?.pages.get(page_id)
            .filter(|page| &page.page.scope == scope)
            .map(|page| page.events.clone())
    }

    pub fn events(&self, page_id: &str) -> Vec<WikiEvent> {
        self.state.lock().map(|s| s.pages.get(page_id).map(|p| p.events.clone()).unwrap_or_default()).unwrap_or_default()
    }

    /// Establish a new document identity. Existing page instances are never
    /// reused across navigation epochs or document identities.
    pub fn establish_page(&self, scope: WikiScope, url: Option<String>, title: Option<String>, navigation_epoch: u64) -> Result<PageInstance> {
        let page = PageInstance {
            schema_version: WIKI_SCHEMA_VERSION.into(),
            page_instance_id: Uuid::new_v4().to_string(),
            scope, url, title, navigation_epoch, revision: 0,
            completeness: if self.load_failed { Completeness::FullRefreshRequired } else { Completeness::Complete }, active: true, invalidated_at: None,
        };
        let mut state = self.state.lock().expect("wiki store mutex poisoned");
        state.pages.insert(page.page_instance_id.clone(), PersistedPage { page: page.clone(), events: Vec::new() });
        self.persist_or_degrade(&mut state)?;
        Ok(page)
    }

    /// Append one local evidence event and allocate its per-page revision.
    /// Duplicate event IDs are idempotent, while gaps can never be created by
    /// this API because the daemon owns revision allocation.
    pub fn ingest(&self, page_id: &str, event_id: Option<String>, kind: WikiEventKind, source: EventSource, payload: Value, completeness: Completeness) -> Result<WikiEvent> {
        let payload_bytes = serde_json::to_vec(&payload)?.len();
        let mut state = self.state.lock().expect("wiki store mutex poisoned");
        if payload_bytes > MAX_EVENT_PAYLOAD_BYTES {
            let known_page = if let Some(page) = state.pages.get_mut(page_id) {
                page.page.completeness = Completeness::FullRefreshRequired;
                true
            } else {
                false
            };
            if known_page {
                self.persist_or_degrade(&mut state)?;
            }
            bail!("wiki event payload exceeds 64 KiB; full refresh required");
        }
        if let Some(id) = event_id.as_deref() {
            if let Some(existing) = state.pages.get(page_id).and_then(|p| p.events.iter().find(|event| event.event_id == id)) {
                return Ok(existing.clone());
            }
        }
        if state.pages.get(page_id).context("unknown wiki page instance")?.events.len() >= MAX_EVENTS_PER_PAGE {
            state.pages.get_mut(page_id).expect("page checked above").page.completeness = Completeness::FullRefreshRequired;
            self.persist_or_degrade(&mut state)?;
            bail!("wiki event history limit reached; full refresh required");
        }
        let event = {
            let persisted = state.pages.get_mut(page_id).expect("page checked above");
            let event = WikiEvent {
                schema_version: WIKI_SCHEMA_VERSION.into(),
                event_id: event_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                page_instance_id: page_id.into(), revision: persisted.page.revision + 1,
                kind, source, payload, predecessor_event_id: persisted.events.last().map(|e| e.event_id.clone()), completeness,
            };
            persisted.page.revision = event.revision;
            persisted.page.completeness = event.completeness.clone();
            persisted.events.push(event.clone());
            event
        };
        self.persist_or_degrade(&mut state)?;
        Ok(event)
    }

    pub fn invalidate(&self, page_id: &str, reason: &str, at: Option<String>) -> Result<()> {
        let mut state = self.state.lock().expect("wiki store mutex poisoned");
        let persisted = state.pages.get_mut(page_id).context("unknown wiki page instance")?;
        persisted.page.active = false;
        persisted.page.completeness = Completeness::Stale;
        persisted.page.invalidated_at = at;
        let payload = json!({ "reason": reason });
        let event = WikiEvent { schema_version: WIKI_SCHEMA_VERSION.into(), event_id: Uuid::new_v4().to_string(), page_instance_id: page_id.into(), revision: persisted.page.revision + 1, kind: WikiEventKind::Error, source: EventSource::Daemon, payload, predecessor_event_id: persisted.events.last().map(|e| e.event_id.clone()), completeness: Completeness::Stale };
        persisted.page.revision = event.revision;
        persisted.events.push(event);
        drop(persisted);
        self.persist_or_degrade(&mut state)
    }

    pub fn scoped_delta(&self, page_id: &str, scope: &WikiScope, from_revision: u64) -> Result<SemanticDelta> {
        let state = self.state.lock().expect("wiki store mutex poisoned");
        let persisted = state.pages.get(page_id).context("unknown wiki page instance")?;
        if &persisted.page.scope != scope { bail!("Wiki scope mismatch"); }
        if from_revision > persisted.page.revision { bail!("revision is ahead of page instance"); }
        let mut added = Vec::new();
        let mut changed = Vec::new();
        let mut removed = Vec::new();
        let mut dirty_regions = Vec::new();
        let mut fallback_reason = None;
        for event in persisted.events.iter().filter(|e| e.revision > from_revision) {
            let Some(payload) = event.payload.as_object() else {
                fallback_reason.get_or_insert("ambiguous_event_payload".to_string());
                continue;
            };
            if let Some(values) = payload.get("added").and_then(Value::as_array) { added.extend(values.iter().cloned()); }
            if let Some(values) = payload.get("changed").and_then(Value::as_array) {
                for value in values {
                    match serde_json::from_value::<ChangedRecord>(value.clone()) {
                        Ok(record) => changed.push(record),
                        Err(_) => { fallback_reason.get_or_insert("ambiguous_changed_record".to_string()); }
                    }
                }
            }
            if let Some(values) = payload.get("removed").and_then(Value::as_array) {
                for value in values {
                    if let Some(id) = value.as_str() { removed.push(id.to_string()); }
                    else { fallback_reason.get_or_insert("ambiguous_removed_identity".to_string()); }
                }
            }
            if let Some(values) = payload.get("dirty_regions").and_then(Value::as_array) {
                for value in values {
                    if let Some(id) = value.as_str() { dirty_regions.push(id.to_string()); }
                    else { fallback_reason.get_or_insert("ambiguous_region_identity".to_string()); }
                }
            }
            if !matches!(&event.completeness, Completeness::Complete) {
                fallback_reason.get_or_insert(format!("event_{:?}", &event.completeness).to_lowercase());
            }
        }
        let completeness = if self.load_failed || persisted.page.completeness == Completeness::FullRefreshRequired || fallback_reason.is_some() {
            Completeness::FullRefreshRequired
        } else { persisted.page.completeness.clone() };
        if completeness == Completeness::FullRefreshRequired && fallback_reason.is_none() {
            fallback_reason = Some(if self.load_failed { "persistence_load_failed" } else { "persistence_or_capture_incomplete" }.into());
        }
        Ok(SemanticDelta { schema_version: WIKI_SCHEMA_VERSION.into(), page_instance_id: page_id.into(), from_revision, to_revision: persisted.page.revision, added, changed, removed, dirty_regions, completeness, fallback_reason })
    }

    pub fn delta(&self, page_id: &str, from_revision: u64) -> Result<SemanticDelta> {
        let state = self.state.lock().expect("wiki store mutex poisoned");
        let scope = state.pages.get(page_id).context("unknown wiki page instance")?.page.scope.clone();
        drop(state);
        self.scoped_delta(page_id, &scope, from_revision)
    }

    fn load(&self) -> Result<()> {
        let Some(root) = self.root.as_deref() else { return Ok(()); };
        let path = root.join("shadow-wiki.json");
        let marker = root.join("shadow-wiki.incomplete");
        let mut state = self.state.lock().expect("wiki store mutex poisoned");
        if marker.exists() {
            if path.exists() { *state = serde_json::from_slice(&fs::read(&path)?)?; }
            for page in state.pages.values_mut() { page.page.completeness = Completeness::FullRefreshRequired; }
            return Ok(());
        }
        if path.exists() { *state = serde_json::from_slice(&fs::read(path)?)?; }
        Ok(())
    }

    fn persist_locked(&self, state: &PersistedStore) -> Result<()> {
        let Some(root) = self.root.as_deref() else { return Ok(()); };
        fs::create_dir_all(root)?;
        let marker = root.join("shadow-wiki.incomplete");
        let path = root.join("shadow-wiki.json");
        let temp = root.join("shadow-wiki.json.tmp");
        File::create(&marker)?.sync_all()?;
        let bytes = serde_json::to_vec_pretty(state)?;
        let mut file = OpenOptions::new().create(true).truncate(true).write(true).open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, &path)?;
        File::open(root)?.sync_all()?;
        fs::remove_file(marker)?;
        Ok(())
    }

    fn persist_or_degrade(&self, state: &mut PersistedStore) -> Result<()> {
        match self.persist_locked(state) {
            Ok(()) => Ok(()),
            Err(error) => {
                for page in state.pages.values_mut() {
                    page.page.completeness = Completeness::FullRefreshRequired;
                }
                Err(error.context("wiki persistence failed; full refresh required"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn scope() -> WikiScope { WikiScope { browser_id: "b".into(), session_id: "s".into(), tab_id: 1, document_id: "d".into(), origin: "https://example.test".into() } }

    #[test]
    fn revisions_are_monotonic_and_restartable() {
        let dir = tempdir().unwrap();
        let store = ShadowWikiStore::new(Some(dir.path().to_path_buf()));
        let page = store.establish_page(scope(), Some("https://example.test/a".into()), None, 1).unwrap();
        let event = store.ingest(&page.page_instance_id, Some("e1".into()), WikiEventKind::Observation, EventSource::Vom, json!({"ref":"@e1"}), Completeness::Complete).unwrap();
        assert_eq!(event.revision, 1);
        assert_eq!(store.ingest(&page.page_instance_id, Some("e1".into()), WikiEventKind::Error, EventSource::Daemon, json!({}), Completeness::Complete).unwrap().revision, 1);
        let restarted = ShadowWikiStore::new(Some(dir.path().to_path_buf()));
        assert_eq!(restarted.page(&page.page_instance_id).unwrap().revision, 1);
    }

    #[test]
    fn oversized_payload_is_rejected_without_revision() {
        let store = ShadowWikiStore::new(None);
        let page = store.establish_page(scope(), None, None, 0).unwrap();
        assert!(store.ingest(&page.page_instance_id, None, WikiEventKind::Observation, EventSource::Dom, Value::String("x".repeat(MAX_EVENT_PAYLOAD_BYTES)), Completeness::Complete).is_err());
        assert_eq!(store.page(&page.page_instance_id).unwrap().revision, 0);
    }

    #[test]
    fn delta_aggregates_semantic_changes_and_dirty_regions() {
        let store = ShadowWikiStore::new(None);
        let page = store.establish_page(scope(), None, None, 0).unwrap();
        store.ingest(&page.page_instance_id, Some("m1".into()), WikiEventKind::Mutation, EventSource::Dom, json!({
            "added": [{"id": "new", "region_id": "list"}],
            "changed": [{"before": {"id": "old"}, "after": {"id": "old", "label": "updated"}, "evidence": ["m1"]}],
            "removed": ["gone"], "dirty_regions": ["list"]
        }), Completeness::Complete).unwrap();
        let delta = store.delta(&page.page_instance_id, 0).unwrap();
        assert_eq!(delta.added.len(), 1);
        assert_eq!(delta.changed.len(), 1);
        assert_eq!(delta.removed, vec!["gone"]);
        assert_eq!(delta.dirty_regions, vec!["list"]);
        assert_eq!(delta.completeness, Completeness::Complete);
    }

    #[test]
    fn malformed_semantic_identity_forces_full_refresh() {
        let store = ShadowWikiStore::new(None);
        let page = store.establish_page(scope(), None, None, 0).unwrap();
        store.ingest(&page.page_instance_id, Some("m1".into()), WikiEventKind::Mutation, EventSource::Dom, json!({
            "removed": [{"not": "an id"}]
        }), Completeness::Complete).unwrap();
        let delta = store.delta(&page.page_instance_id, 0).unwrap();
        assert_eq!(delta.completeness, Completeness::FullRefreshRequired);
        assert_eq!(delta.fallback_reason.as_deref(), Some("ambiguous_removed_identity"));
    }

    #[test]
    fn scoped_reads_require_exact_five_field_identity() {
        let store = ShadowWikiStore::new(None);
        let page = store.establish_page(scope(), None, None, 0).unwrap();
        store.ingest(&page.page_instance_id, Some("e1".into()), WikiEventKind::Observation, EventSource::Vom, json!({"safe": true}), Completeness::Complete).unwrap();
        assert!(store.scoped_page(&page.page_instance_id, &scope()).is_some());
        assert_eq!(store.scoped_events(&page.page_instance_id, &scope()).unwrap().len(), 1);
        assert!(store.scoped_delta(&page.page_instance_id, &scope(), 0).is_ok());

        let mut mismatches = Vec::new();
        let mut browser = scope(); browser.browser_id = "other-browser".into(); mismatches.push(browser);
        let mut session = scope(); session.session_id = "other-session".into(); mismatches.push(session);
        let mut tab = scope(); tab.tab_id = 2; mismatches.push(tab);
        let mut document = scope(); document.document_id = "other-document".into(); mismatches.push(document);
        let mut origin = scope(); origin.origin = "https://other.example".into(); mismatches.push(origin);
        for mismatch in mismatches {
            assert!(store.scoped_page(&page.page_instance_id, &mismatch).is_none());
            assert!(store.scoped_events(&page.page_instance_id, &mismatch).is_none());
            assert!(store.scoped_delta(&page.page_instance_id, &mismatch, 0).is_err());
        }
    }
}
