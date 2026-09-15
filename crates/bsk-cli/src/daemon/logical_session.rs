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
            if let Ok(path) = paths::current_session_path() { let _ = fs::remove_file(path); }
        }
    }
}
