//! Stable logical session aliases. Physical session ids are short-lived
//! implementation details and are only persisted as recoverable state.

use std::fs;
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::paths;
use super::sessions::{SessionId, SessionRegistry};

pub const DEFAULT_SESSION: &str = "default";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CurrentSession {
    logical_name: String,
    physical_session_id: String,
}

#[derive(Debug)]
pub struct LogicalSessionStore {
    current: Mutex<Option<SessionId>>,
}

impl LogicalSessionStore {
    pub fn load() -> Self {
        let current = paths::current_session_path()
            .ok()
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|raw| serde_json::from_str::<CurrentSession>(&raw).ok())
            .filter(|state| state.logical_name == DEFAULT_SESSION)
            .map(|state| SessionId(state.physical_session_id));
        Self {
            current: Mutex::new(current),
        }
    }

    pub fn resolve(&self, sessions: &SessionRegistry, logical: &str) -> Option<SessionId> {
        if logical != DEFAULT_SESSION {
            return Some(SessionId(logical.to_owned()));
        }
        let current = self
            .current
            .lock()
            .expect("logical session store poisoned")
            .clone();
        current.filter(|id| sessions.get(id).is_some())
    }

    pub fn set_default(&self, id: &SessionId) -> Result<()> {
        *self.current.lock().expect("logical session store poisoned") = Some(id.clone());
        let path = paths::current_session_path()?;
        paths::ensure_bsk_home()?;
        let state = CurrentSession {
            logical_name: DEFAULT_SESSION.into(),
            physical_session_id: id.0.clone(),
        };
        let json = serde_json::to_string_pretty(&state).context("serialize current session")?;
        fs::write(&path, format!("{json}\n")).with_context(|| format!("write {}", path.display()))
    }

    pub fn clear_if(&self, id: &SessionId) {
        let mut current = self.current.lock().expect("logical session store poisoned");
        if current.as_ref() == Some(id) {
            *current = None;
            if let Ok(path) = paths::current_session_path() {
                let _ = fs::remove_file(path);
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn test_env_lock() -> std::sync::MutexGuard<'static, ()> {
    paths::test_env_lock()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::browsers::BrowserId;
    use crate::daemon::paths::BSK_HOME_ENV;
    use crate::daemon::sessions::Session;

    fn with_temp_home<F: FnOnce()>(f: F) {
        let _lock = test_env_lock();
        let tmp = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var(BSK_HOME_ENV, tmp.path().join("bsk"));
        }
        f();
        unsafe {
            std::env::remove_var(BSK_HOME_ENV);
        }
    }

    fn fake_session(id: &str) -> Session {
        Session {
            interaction: None,
            id: SessionId(id.into()),
            browser_id: BrowserId("browser".into()),
            agent_window_id: Some(1),
            created_at_ms: 0,
        }
    }

    #[test]
    fn resolve_default_returns_none_when_no_default_set() {
        with_temp_home(|| {
            let store = LogicalSessionStore::load();
            let sessions = SessionRegistry::new();
            assert_eq!(store.resolve(&sessions, DEFAULT_SESSION), None);
        });
    }

    #[test]
    fn resolve_passes_explicit_physical_ids_through_unchanged() {
        with_temp_home(|| {
            let store = LogicalSessionStore::load();
            let sessions = SessionRegistry::new();
            // No matching session needed: explicit ids are pass-through.
            let resolved = store.resolve(&sessions, "abcd");
            assert_eq!(resolved, Some(SessionId("abcd".into())));
        });
    }

    #[test]
    fn set_default_persists_to_user_bsk_home() {
        with_temp_home(|| {
            let store = LogicalSessionStore::load();
            store.set_default(&SessionId("abcd".into())).unwrap();
            // The default points at an id that the registry does not
            // hold yet (no sessions were started), so the resolver
            // treats it as stale until the physical session exists.
            let sessions = SessionRegistry::new();
            assert_eq!(store.resolve(&sessions, DEFAULT_SESSION), None);

            // On-disk state survives a fresh store; once a matching
            // physical session is present, the resolver hands it back.
            let reloaded = LogicalSessionStore::load();
            let sessions = SessionRegistry::new();
            sessions.insert(fake_session("abcd"));
            assert_eq!(
                reloaded.resolve(&sessions, DEFAULT_SESSION),
                Some(SessionId("abcd".into()))
            );

            // The persisted file lives in the user-level BSK home so
            // agent workflows survive across shell invocations.
            assert!(paths::current_session_path().unwrap().exists());
        });
    }

    #[test]
    fn resolve_drops_default_whose_physical_session_is_gone() {
        with_temp_home(|| {
            let store = LogicalSessionStore::load();
            store.set_default(&SessionId("abcd".into())).unwrap();
            let empty_registry = SessionRegistry::new();
            // Stale physical id must not be returned; the caller should
            // start a fresh session rather than reuse a dead id.
            assert_eq!(store.resolve(&empty_registry, DEFAULT_SESSION), None);
        });
    }

    #[test]
    fn resolve_returns_physical_when_default_session_is_active() {
        with_temp_home(|| {
            let store = LogicalSessionStore::load();
            store.set_default(&SessionId("abcd".into())).unwrap();
            let sessions = SessionRegistry::new();
            sessions.insert(fake_session("abcd"));
            assert_eq!(
                store.resolve(&sessions, DEFAULT_SESSION),
                Some(SessionId("abcd".into()))
            );
        });
    }

    #[test]
    fn clear_if_removes_matching_default_and_persisted_file() {
        with_temp_home(|| {
            let store = LogicalSessionStore::load();
            store.set_default(&SessionId("abcd".into())).unwrap();
            store.clear_if(&SessionId("abcd".into()));
            let sessions = SessionRegistry::new();
            assert_eq!(store.resolve(&sessions, DEFAULT_SESSION), None);

            // Persistence layer should also be gone so a fresh store
            // sees no current session after a stop.
            let reloaded = LogicalSessionStore::load();
            let sessions = SessionRegistry::new();
            assert_eq!(reloaded.resolve(&sessions, DEFAULT_SESSION), None);
        });
    }

    #[test]
    fn clear_if_leaves_unrelated_default_alone() {
        with_temp_home(|| {
            let store = LogicalSessionStore::load();
            store.set_default(&SessionId("abcd".into())).unwrap();
            // Stopping a different physical session must not wipe the
            // agent's current default mapping.
            store.clear_if(&SessionId("zzzz".into()));
            let sessions = SessionRegistry::new();
            sessions.insert(fake_session("abcd"));
            assert_eq!(
                store.resolve(&sessions, DEFAULT_SESSION),
                Some(SessionId("abcd".into()))
            );
        });
    }

    #[test]
    fn set_default_overwrites_previous_default() {
        with_temp_home(|| {
            let store = LogicalSessionStore::load();
            store.set_default(&SessionId("aaaa".into())).unwrap();
            store.set_default(&SessionId("bbbb".into())).unwrap();
            let sessions = SessionRegistry::new();
            sessions.insert(fake_session("bbbb"));
            assert_eq!(
                store.resolve(&sessions, DEFAULT_SESSION),
                Some(SessionId("bbbb".into()))
            );
        });
    }

    #[test]
    fn load_ignores_state_with_wrong_logical_name() {
        with_temp_home(|| {
            // Seed an off-spec file claiming the legacy 4-letter alias
            // is logical; the loader must treat the file as missing so
            // a stray alias from another tool cannot impersonate the
            // stable default.
            let path = paths::current_session_path().unwrap();
            paths::ensure_bsk_home().unwrap();
            std::fs::write(
                &path,
                r#"{
  "logical_name": "abcd",
  "physical_session_id": "zzzz"
}"#,
            )
            .unwrap();
            let store = LogicalSessionStore::load();
            let sessions = SessionRegistry::new();
            assert_eq!(store.resolve(&sessions, DEFAULT_SESSION), None);
        });
    }
}
