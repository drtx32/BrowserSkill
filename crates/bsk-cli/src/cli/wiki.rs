//! Read-only Browser Wiki and bounded retrieval commands.

use anyhow::Context;
use bsk_protocol::{Method, WikiScope};
use clap::{Args, Subcommand};
use serde_json::{Value, json};

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct WikiCmd { #[command(subcommand)] pub sub: WikiSub }

#[derive(Debug, Clone, Subcommand)]
pub enum WikiSub {
    /// Negotiate the locally available, read-only Wiki capabilities.
    Capabilities,
    /// Return one scoped page's freshness and completeness receipt.
    Status(WikiScopeArgs),
    /// Return the bounded compiled view for one scoped page.
    View(WikiQueryArgs),
    /// Return changes after a page revision.
    Delta(WikiDeltaArgs),
    /// Route a task query through refs, regions, deltas, lexical/semantic data,
    /// and report when a fresh observe fallback is required.
    Retrieve(WikiQueryArgs),
}

#[derive(Debug, Clone, Args)]
pub struct WikiScopeArgs {
    #[arg(long)] pub page_instance_id: String,
    #[arg(long)] pub browser_id: String,
    #[arg(long, default_value = "default")] pub session_id: String,
    #[arg(long)] pub tab_id: i64,
    #[arg(long)] pub document_id: String,
    #[arg(long)] pub origin: String,
}

#[derive(Debug, Clone, Args)]
pub struct WikiQueryArgs {
    #[command(flatten)] pub scope: WikiScopeArgs,
    #[arg(long)] pub ref_id: Option<String>,
    #[arg(long)] pub region_id: Option<String>,
    #[arg(long)] pub since_revision: Option<u64>,
    #[arg(long)] pub text: Option<String>,
    #[arg(long)] pub semantic: bool,
    #[arg(long, default_value_t = 32)] pub limit: usize,
}

#[derive(Debug, Clone, Args)]
pub struct WikiDeltaArgs { #[command(flatten)] pub scope: WikiScopeArgs, #[arg(long)] pub from_revision: u64 }

pub fn dispatch(cmd: WikiCmd, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let (method, params) = match cmd.sub {
        WikiSub::Capabilities => (Method::WikiCapabilities, json!({})),
        WikiSub::Status(args) => (Method::WikiStatus, scoped(&args)),
        WikiSub::View(args) => (Method::WikiView, query(&args)),
        WikiSub::Delta(args) => {
            let mut value = scoped(&args.scope);
            value["from_revision"] = json!(args.from_revision);
            (Method::WikiDelta, value)
        }
        WikiSub::Retrieve(args) => (Method::WikiRetrieve, query(&args)),
    };
    let result: Value = crate::cli::business_rpc::call(
        info.sock_path, "wiki", method, Some(params), TOOL_IPC_TIMEOUT,
    )?;
    match format {
        Format::Json | Format::Human => println!("{}", serde_json::to_string_pretty(&result).map_err(|e| CliError::Local(e.into()))?),
    }
    Ok(())
}

fn scoped(args: &WikiScopeArgs) -> Value { json!({"page_instance_id": args.page_instance_id, "scope": scope(args)}) }
fn query(args: &WikiQueryArgs) -> Value {
    let mut value = scoped(&args.scope);
    value["query"] = json!({"ref_id": args.ref_id, "region_id": args.region_id, "since_revision": args.since_revision, "text": args.text, "semantic": args.semantic, "limit": args.limit});
    value
}
fn scope(args: &WikiScopeArgs) -> WikiScope { WikiScope { browser_id: args.browser_id.clone(), session_id: args.session_id.clone(), tab_id: args.tab_id, document_id: args.document_id.clone(), origin: args.origin.clone() } }

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    #[derive(Parser)] struct P { #[command(subcommand)] sub: WikiSub }
    #[test]
    fn retrieval_help_shape_is_parseable() {
        let parsed = P::try_parse_from(["bsk", "retrieve", "--page-instance-id", "p", "--browser-id", "b", "--tab-id", "1", "--document-id", "d", "--origin", "https://example.test", "--text", "invoice", "--semantic"]).unwrap();
        assert!(matches!(parsed.sub, WikiSub::Retrieve(_)));
    }
}
