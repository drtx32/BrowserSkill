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
use bsk_protocol::{Completeness, EventSource, PageInstance, SemanticDelta, WikiEvent,
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
}

impl ShadowWikiStore {
    pub fn new(root: Option<PathBuf>) -> Self {
        let store = Self { root, state: Mutex::new(PersistedStore::default()) };
        let _ = store.load();
        store
    }

    pub fn page(&self, page_id: &str) -> Option<PageInstance> {
        self.state.lock().ok()?.pages.get(page_id).map(|p| p.page.clone())
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
            completeness: Completeness::Complete, active: true, invalidated_at: None,
        };
        let mut state = self.state.lock().expect("wiki store mutex poisoned");
        state.pages.insert(page.page_instance_id.clone(), PersistedPage { page: page.clone(), events: Vec::new() });
        self.persist_locked(&state)?;
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
                self.persist_locked(&state)?;
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
            self.persist_locked(&state)?;
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
        self.persist_locked(&state)?;
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
        self.persist_locked(&state)
    }

    pub fn delta(&self, page_id: &str, from_revision: u64) -> Result<SemanticDelta> {
        let state = self.state.lock().expect("wiki store mutex poisoned");
        let persisted = state.pages.get(page_id).context("unknown wiki page instance")?;
        if from_revision > persisted.page.revision { bail!("revision is ahead of page instance"); }
        let events: Vec<Value> = persisted.events.iter().filter(|e| e.revision > from_revision).map(|e| json!({"event_id": e.event_id, "kind": e.kind, "source": e.source, "payload": e.payload, "revision": e.revision})).collect();
        Ok(SemanticDelta { schema_version: WIKI_SCHEMA_VERSION.into(), page_instance_id: page_id.into(), from_revision, to_revision: persisted.page.revision, added: events, changed: Vec::new(), removed: Vec::new(), dirty_regions: Vec::new(), completeness: persisted.page.completeness.clone(), fallback_reason: (persisted.page.completeness == Completeness::FullRefreshRequired).then_some("persistence_or_capture_incomplete".into()) })
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
}
