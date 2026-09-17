//! Short-lived browser control leases.
//!
//! A lease is daemon-local by design: it protects the shared, persistent
//! browser connection without owning or closing that connection. Expiry only
//! removes mutation authority, which makes crashes and client timeouts safe.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use bsk_protocol::system::BrowserLeaseStatus;

pub const DEFAULT_LEASE_TTL_MS: u64 = 30_000;
pub const MAX_LEASE_TTL_MS: u64 = 120_000;

#[derive(Debug, Clone)]
struct Lease {
    owner: String,
    token: String,
    acquired_at_ms: i64,
    expires_at_ms: i64,
}

#[derive(Debug, Default)]
pub struct LeaseRegistry {
    leases: Mutex<HashMap<String, Lease>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcquireError {
    Held(BrowserLeaseStatus),
}

impl LeaseRegistry {
    pub fn new() -> Self { Self::default() }

    pub fn acquire(&self, browser_id: &str, owner: &str, ttl_ms: Option<u64>) -> Result<BrowserLeaseStatus, AcquireError> {
        let now = now_ms();
        let ttl = ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS).clamp(1_000, MAX_LEASE_TTL_MS);
        let mut leases = self.leases.lock().expect("lease registry poisoned");
        if let Some(existing) = leases.get(browser_id).cloned() {
            if existing.expires_at_ms > now && existing.owner != owner {
                return Err(AcquireError::Held(public_status(browser_id, &existing, now)));
            }
        }
        let token = format!("{owner}-{}", uuid::Uuid::new_v4());
        let lease = Lease { owner: owner.into(), token, acquired_at_ms: now, expires_at_ms: now + ttl as i64 };
        let result = status_with_token(browser_id, &lease, now);
        leases.insert(browser_id.into(), lease);
        Ok(result)
    }

    pub fn renew(&self, browser_id: &str, owner: &str, token: &str, ttl_ms: Option<u64>) -> Result<BrowserLeaseStatus, String> {
        let now = now_ms();
        let ttl = ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS).clamp(1_000, MAX_LEASE_TTL_MS);
        let mut leases = self.leases.lock().expect("lease registry poisoned");
        let lease = leases.get_mut(browser_id).ok_or_else(|| "no active browser lease".to_string())?;
        if lease.owner != owner || lease.token != token || lease.expires_at_ms <= now {
            return Err("lease is expired or owned by another controller".into());
        }
        lease.expires_at_ms = now + ttl as i64;
        Ok(status_with_token(browser_id, lease, now))
    }

    pub fn release(&self, browser_id: &str, owner: &str, token: Option<&str>) -> Result<(), String> {
        let mut leases = self.leases.lock().expect("lease registry poisoned");
        let Some(lease) = leases.get(browser_id) else { return Ok(()); };
        if lease.owner != owner || token.is_some_and(|token| token != lease.token) {
            return Err("lease is owned by another controller".into());
        }
        leases.remove(browser_id);
        Ok(())
    }

    pub fn require(&self, browser_id: &str, owner: &str) -> Result<(), BrowserLeaseStatus> {
        let now = now_ms();
        let mut leases = self.leases.lock().expect("lease registry poisoned");
        if let Some(lease) = leases.get(browser_id) {
            if lease.expires_at_ms > now && lease.owner == owner { return Ok(()); }
            if lease.expires_at_ms <= now { leases.remove(browser_id); }
        }
        Err(self.status_locked(&leases, browser_id, now))
    }

    /// Recover mutation authority after this controller's lease naturally
    /// expires, but only while the browser lease is still free. Also
    /// acquires fresh when the daemon lost the prior lease record (e.g.
    /// restart) but the same logical session is still bound to this
    /// browser — the browser is provably free because no record exists,
    /// so the new owner cannot be stealing from anyone.
    pub fn require_or_reacquire(&self, browser_id: &str, owner: &str) -> Result<(), BrowserLeaseStatus> {
        let now = now_ms();
        let mut leases = self.leases.lock().expect("lease registry poisoned");
        if let Some(existing) = leases.get(browser_id).cloned() {
            if existing.expires_at_ms > now {
                return if existing.owner == owner {
                    Ok(())
                } else {
                    Err(public_status(browser_id, &existing, now))
                };
            }
            // Expired record: only the prior owner may rehydrate; any
            // other caller must explicitly acquire (or wait for natural
            // expiry).
            if existing.owner != owner {
                return Err(BrowserLeaseStatus::free(browser_id));
            }
        }
        // Either no record (browser free, lease map empty) or same-owner
        // expired record. The browser is free in both cases; acquire fresh.
        let token = format!("{owner}-{}", uuid::Uuid::new_v4());
        let lease = Lease {
            owner: owner.into(),
            token,
            acquired_at_ms: now,
            expires_at_ms: now + DEFAULT_LEASE_TTL_MS as i64,
        };
        leases.insert(browser_id.into(), lease);
        Ok(())
    }

    /// Renew on accepted mutation dispatches so a healthy controller does not
    /// lose authority mid-task. The hard cap is still enforced by `renew`.
    pub fn touch(&self, browser_id: &str, owner: &str) {
        let now = now_ms();
        let mut leases = self.leases.lock().expect("lease registry poisoned");
        if let Some(lease) = leases.get_mut(browser_id)
            && lease.owner == owner
            && lease.expires_at_ms > now
        {
            lease.expires_at_ms = now + DEFAULT_LEASE_TTL_MS as i64;
        }
    }

    pub fn status(&self, browser_id: &str) -> BrowserLeaseStatus {
        let now = now_ms();
        let leases = self.leases.lock().expect("lease registry poisoned");
        self.status_locked(&leases, browser_id, now)
    }

    pub fn status_all(&self) -> Vec<BrowserLeaseStatus> {
        let now = now_ms();
        let leases = self.leases.lock().expect("lease registry poisoned");
        leases.iter().filter(|(_, lease)| lease.expires_at_ms > now).map(|(browser, lease)| public_status(browser, lease, now)).collect()
    }

    fn status_locked(&self, leases: &HashMap<String, Lease>, browser_id: &str, now: i64) -> BrowserLeaseStatus {
        leases.get(browser_id).filter(|lease| lease.expires_at_ms > now).map_or_else(|| BrowserLeaseStatus::free(browser_id), |lease| public_status(browser_id, lease, now))
    }
}

fn public_status(browser_id: &str, lease: &Lease, now: i64) -> BrowserLeaseStatus {
    let mut status = status_with_token(browser_id, lease, now);
    status.token = None;
    status
}

fn status_with_token(browser_id: &str, lease: &Lease, now: i64) -> BrowserLeaseStatus {
    BrowserLeaseStatus {
        browser_instance_id: browser_id.into(),
        owner: Some(lease.owner.clone()),
        token: Some(lease.token.clone()),
        acquired_at_ms: Some(lease.acquired_at_ms),
        expires_at_ms: Some(lease.expires_at_ms),
        remaining_ms: Some((lease.expires_at_ms - now).max(0) as u64),
    }
}

pub fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_writer_can_hold_a_browser() {
        let leases = LeaseRegistry::new();
        let first = leases.acquire("browser", "writer-a", Some(5_000)).unwrap();
        let denied = leases.acquire("browser", "writer-b", Some(5_000)).unwrap_err();
        let AcquireError::Held(holder) = denied;
        assert_eq!(holder.browser_instance_id, "browser");
        assert_eq!(holder.owner.as_deref(), Some("writer-a"));
        assert_eq!(holder.token, None);
        assert_eq!(holder.expires_at_ms, first.expires_at_ms);
        assert!(leases.require("browser", "writer-a").is_ok());
        assert!(leases.require("browser", "writer-b").is_err());
    }

    #[test]
    fn release_allows_handoff_and_wrong_owner_cannot_release() {
        let leases = LeaseRegistry::new();
        let first = leases.acquire("browser", "writer-a", Some(5_000)).unwrap();
        assert!(leases.release("browser", "writer-b", first.token.as_deref()).is_err());
        leases.release("browser", "writer-a", first.token.as_deref()).unwrap();
        assert_eq!(leases.acquire("browser", "writer-b", Some(5_000)).unwrap().owner.as_deref(), Some("writer-b"));
    }

    #[test]
    fn expired_lease_is_recovered_without_granting_stale_owner_access() {
        let leases = LeaseRegistry::new();
        let old = leases.acquire("browser", "writer-a", Some(1_000)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1_050));
        assert!(leases.require("browser", "writer-a").is_err());
        let fresh = leases.acquire("browser", "writer-b", Some(5_000)).unwrap();
        assert_ne!(old.token, fresh.token);
        assert!(leases.require("browser", "writer-a").is_err());
        assert!(leases.require("browser", "writer-b").is_ok());
    }

    #[test]
    fn expired_lease_is_lazily_reacquired_only_by_same_owner() {
        let leases = LeaseRegistry::new();
        leases.acquire("browser", "writer-a", Some(1_000)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1_050));
        assert!(leases.require_or_reacquire("browser", "writer-a").is_ok());
        assert!(leases.require_or_reacquire("browser", "writer-b").is_err());
    }

    #[test]
    fn explicit_release_then_same_owner_reacquires_fresh() {
        // After explicit release the browser is free. The next mutation
        // from the same owner must auto-acquire fresh — the prior
        // implementation treated "no record" as a hard fail, which broke
        // ELI-242 gate #3 once a daemon restart also produced a missing
        // record (in-memory lease map) for a still-bound session.
        let leases = LeaseRegistry::new();
        let first = leases.acquire("browser", "writer-a", Some(1_000)).unwrap();
        leases.release("browser", "writer-a", first.token.as_deref()).unwrap();
        assert!(leases.require_or_reacquire("browser", "writer-a").is_ok());
    }

    #[test]
    fn fresh_session_without_lease_record_lazily_acquires() {
        // Daemon restart drops the in-memory lease map while the logical
        // session is still bound to the browser. The next mutation from
        // the same session must safely auto-acquire without a manual
        // `lease acquire`, because the browser is provably free — no
        // record means no other owner can possibly hold it.
        let leases = LeaseRegistry::new();
        assert!(leases.require_or_reacquire("browser", "session-x").is_ok());
        assert!(leases.require("browser", "session-x").is_ok());
        let other = leases.require_or_reacquire("browser", "session-y");
        let BrowserLeaseStatus { owner, token, remaining_ms, .. } = other.unwrap_err();
        assert_eq!(owner.as_deref(), Some("session-x"));
        assert_eq!(token, None);
        assert!(remaining_ms.unwrap_or(0) > 0);
    }

    #[test]
    fn competing_active_owner_still_fails_closed() {
        // The fix must not weaken the active-controller denial: a
        // genuinely live lease owned by someone else must still return
        // permission_denied with the holder, never silently steal.
        let leases = LeaseRegistry::new();
        leases.acquire("browser", "writer-a", Some(5_000)).unwrap();
        let denied = leases.require_or_reacquire("browser", "writer-b").unwrap_err();
        let BrowserLeaseStatus { owner, token, .. } = denied;
        assert_eq!(owner.as_deref(), Some("writer-a"));
        assert_eq!(token, None);
        assert!(leases.require_or_reacquire("browser", "writer-a").is_ok());
    }
}
