//! `bsk bootstrap` — connect to a real browser and ensure the default session.
//!
//! This is deliberately a thin orchestration layer. Browser profile and login
//! state remain owned by the user's browser; BSK only discovers the extension
//! connection and, when explicitly asked, starts the supplied executable.

use std::path::PathBuf;
use std::process::Child;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use clap::Args;
use serde::{Deserialize, Serialize};

use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::session::{SessionStartOptions, ensure_session};
use crate::cli::status::query_sock_with_wait;
use crate::daemon::logical_session::DEFAULT_SESSION;
use crate::daemon::paths;

const MAX_WAIT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Args)]
pub struct BootstrapArgs {
    /// Existing browser instance id or label. Required when several are online.
    #[arg(long)]
    pub browser: Option<String>,

    /// Browser executable to start if no BrowserSkill connection is online.
    /// The process uses the browser's normal profile and receives no data-dir
    /// or profile flags.
    #[arg(long, alias = "executable")]
    pub browser_executable: Option<PathBuf>,

    /// Maximum time to wait for the extension connection, in milliseconds.
    #[arg(long, default_value_t = 35_000)]
    pub wait_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BootstrapState {
    logical_session: String,
    physical_session_id: String,
    browser_instance_id: String,
    browser_name: String,
    browser_version: String,
    executable: Option<String>,
    launched_pid: Option<u32>,
    updated_at_epoch_secs: u64,
}

pub fn dispatch(args: BootstrapArgs, format: Format) -> Result<(), CliError> {
    run(args, format).map_err(CliError::Local)
}

fn run(args: BootstrapArgs, format: Format) -> Result<()> {
    let daemon = ensure_daemon().context("ensure daemon is running")?;
    let wait = Duration::from_millis(args.wait_ms).min(MAX_WAIT);
    let mut launched: Option<Child> = None;
    let mut status = query_sock_with_wait(daemon.sock_path.clone(), Duration::ZERO)
        .context("query connected browsers")?;

    if status.browsers.is_empty() {
        let executable = args
            .browser_executable
            .as_ref()
            .context("no BrowserSkill browser is connected; pass --browser-executable or open a browser with the extension")?;
        let child = std::process::Command::new(executable)
            .spawn()
            .with_context(|| format!("launch browser executable {}", executable.display()))?;
        launched = Some(child);
    }

    let deadline = std::time::Instant::now() + wait.max(Duration::from_millis(1));
    loop {
        status = query_sock_with_wait(daemon.sock_path.clone(), Duration::ZERO)
            .context("wait for BrowserSkill extension connection")?;
        if !status.browsers.is_empty() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            bail!("BrowserSkill extension did not connect within {:?}", wait);
        }
        if let Some(child) = launched.as_mut()
            && child.try_wait()?.is_some()
        {
            bail!("browser executable exited before the BrowserSkill extension connected");
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let reply = ensure_session(
        daemon.sock_path.clone(),
        SessionStartOptions {
            browser: args.browser,
            ..SessionStartOptions::default()
        },
    )?;
    let browser = status
        .browsers
        .iter()
        .find(|browser| browser.instance_id == reply.browser_instance_id)
        .with_context(|| format!("connected browser {} disappeared", reply.browser_instance_id))?;
    let executable = args
        .browser_executable
        .as_ref()
        .map(|path| path.canonicalize().unwrap_or_else(|_| path.clone()).display().to_string());
    let state = BootstrapState {
        logical_session: DEFAULT_SESSION.into(),
        physical_session_id: reply.session_id,
        browser_instance_id: browser.instance_id.clone(),
        browser_name: browser.browser_name.clone(),
        browser_version: browser.browser_version.clone(),
        executable,
        launched_pid: launched.as_ref().map(Child::id),
        updated_at_epoch_secs: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    write_state(&state)?;

    match format {
        Format::Human => println!("{}", DEFAULT_SESSION),
        Format::Json => println!("{}", serde_json::to_string_pretty(&state)?),
    }
    // Dropping Child intentionally leaves an explicitly launched browser
    // alive. Its normal profile and login state belong to the user.
    drop(launched);
    Ok(())
}

fn write_state(state: &BootstrapState) -> Result<()> {
    let home = paths::ensure_bsk_home()?;
    let path = home.join(".bsk-session");
    let tmp = home.join(format!(".bsk-session.tmp.{}", std::process::id()));
    std::fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(state)?))
        .with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}
