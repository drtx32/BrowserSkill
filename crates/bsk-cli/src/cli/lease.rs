//! Explicit browser control lease commands.

use std::time::Duration;

use bsk_protocol::{Method, system::BrowserLeaseStatus};
use clap::{Args, Subcommand};

use crate::cli::business_rpc::call;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct LeaseCmd {
    #[command(subcommand)]
    pub sub: LeaseSub,
}

#[derive(Debug, Clone, Subcommand)]
pub enum LeaseSub {
    Acquire(LeaseArgs),
    Renew(LeaseRenewArgs),
    Release(LeaseReleaseArgs),
    Status(LeaseStatusArgs),
}

#[derive(Debug, Clone, Args)]
pub struct LeaseArgs {
    #[arg(long)]
    pub browser: String,
    #[arg(long)]
    pub owner: String,
    #[arg(long, default_value_t = 30_000)]
    pub ttl_ms: u64,
}

#[derive(Debug, Clone, Args)]
pub struct LeaseRenewArgs {
    #[command(flatten)]
    pub lease: LeaseArgs,
    #[arg(long)]
    pub token: String,
}
#[derive(Debug, Clone, Args)]
pub struct LeaseReleaseArgs {
    #[command(flatten)]
    pub lease: LeaseArgs,
    #[arg(long)]
    pub token: Option<String>,
}
#[derive(Debug, Clone, Args)]
pub struct LeaseStatusArgs {
    #[arg(long)]
    pub browser: String,
}

pub fn dispatch(cmd: LeaseCmd, format: Format) -> Result<(), CliError> {
    let sock = ensure_daemon().map_err(CliError::Local)?.sock_path;
    let (method, params) = match &cmd.sub {
        LeaseSub::Acquire(a) => (
            Method::LeaseAcquire,
            serde_json::json!({"browser_instance_id": a.browser, "owner": a.owner, "ttl_ms": a.ttl_ms}),
        ),
        LeaseSub::Renew(a) => (
            Method::LeaseRenew,
            serde_json::json!({"browser_instance_id": a.lease.browser, "owner": a.lease.owner, "token": a.token, "ttl_ms": a.lease.ttl_ms}),
        ),
        LeaseSub::Release(a) => (
            Method::LeaseRelease,
            serde_json::json!({"browser_instance_id": a.lease.browser, "owner": a.lease.owner, "token": a.token}),
        ),
        LeaseSub::Status(a) => (
            Method::LeaseStatus,
            serde_json::json!({"browser_instance_id": a.browser, "owner": "status"}),
        ),
    };
    let value: BrowserLeaseStatus = if method == Method::LeaseStatus {
        call(
            sock,
            "lease-status",
            method,
            Some(params),
            Duration::from_secs(5),
        )?
    } else {
        call(sock, "lease", method, Some(params), Duration::from_secs(5))?
    };
    match format {
        Format::Json => println!(
            "{}",
            serde_json::to_string_pretty(&value).map_err(|e| CliError::Local(e.into()))?
        ),
        Format::Human => println!(
            "browser {}  {}  owner {}  remaining {}ms{}",
            value.browser_instance_id,
            if value.owner.is_some() {
                "held"
            } else {
                "free"
            },
            value.owner.as_deref().unwrap_or("-"),
            value.remaining_ms.unwrap_or(0),
            value
                .token
                .as_deref()
                .map(|t| format!("  token {t}"))
                .unwrap_or_default()
        ),
    }
    Ok(())
}
