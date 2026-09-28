//! End-to-end lease command coverage through the real daemon and CLI binary.

#![cfg(unix)]

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, MutexGuard};

use tempfile::TempDir;

static LEASE_CMD_TEST_LOCK: Mutex<()> = Mutex::new(());

fn lease_cmd_test_guard() -> MutexGuard<'static, ()> {
    LEASE_CMD_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn bsk_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_bsk"))
}

#[test]
fn lease_acquire_renew_release_round_trip_returns_success() {
    let _guard = lease_cmd_test_guard();
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();
    let envs = |cmd: &mut std::process::Command| {
        cmd.env("BSK_HOME", &home)
            .env("BSK_AUTO_UPDATE", "0")
            .env("RUST_LOG", "warn");
    };

    let mut start = Command::new(bsk_bin());
    start.args(["daemon", "start", "--port", "0", "--daemon-idle", "60s"]);
    envs(&mut start);
    let output = start.output().unwrap();
    assert!(
        output.status.success(),
        "daemon start failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let browser = "lease-test-browser";
    let owner = "lease-test-owner";
    let acquire = run_json(
        &home,
        [
            "--json",
            "lease",
            "acquire",
            "--browser",
            browser,
            "--owner",
            owner,
            "--ttl-ms",
            "30000",
        ],
    );
    assert!(acquire.status.success(), "acquire failed: {acquire:?}");
    let token = serde_json::from_slice::<serde_json::Value>(&acquire.stdout).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();

    let renew = run_json(
        &home,
        [
            "--json",
            "lease",
            "renew",
            "--browser",
            browser,
            "--owner",
            owner,
            "--token",
            &token,
            "--ttl-ms",
            "30000",
        ],
    );
    assert!(renew.status.success(), "renew failed: {renew:?}");

    let release = run_json(
        &home,
        [
            "--json",
            "lease",
            "release",
            "--browser",
            browser,
            "--owner",
            owner,
            "--token",
            &token,
        ],
    );
    assert!(
        release.status.success(),
        "release failed: stdout={} stderr={}",
        String::from_utf8_lossy(&release.stdout),
        String::from_utf8_lossy(&release.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&release.stdout).unwrap(),
        serde_json::json!({"released": true})
    );

    let mut stop = Command::new(bsk_bin());
    stop.args(["daemon", "stop"]);
    envs(&mut stop);
    let _ = stop.output();
}

fn run_json<const N: usize>(home: &std::path::Path, args: [&str; N]) -> std::process::Output {
    let mut command = Command::new(bsk_bin());
    command
        .args(args)
        .env("BSK_HOME", home)
        .env("RUST_LOG", "warn");
    command.output().unwrap()
}
