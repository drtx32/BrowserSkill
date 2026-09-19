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
    /// Discover the current active Wiki page for a logical session.
    Current(WikiSessionArgs),
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
    #[arg(long)] pub page_instance_id: Option<String>,
    #[arg(long)] pub browser_id: Option<String>,
    #[arg(long, default_value = "default")] pub session_id: String,
    #[arg(long)] pub tab_id: Option<i64>,
    #[arg(long)] pub document_id: Option<String>,
    #[arg(long)] pub origin: Option<String>,
}

#[derive(Debug, Clone, Args)]
pub struct WikiSessionArgs { #[arg(long, default_value = "default")] pub session_id: String }

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
        WikiSub::Current(args) => (Method::WikiStatus, json!({"session_id": args.session_id, "current": true})),
        WikiSub::Status(args) => (Method::WikiStatus, scoped(&args)?),
        WikiSub::View(args) => (Method::WikiView, query(&args)?),
        WikiSub::Delta(args) => {
            let mut value = scoped(&args.scope)?;
            value["from_revision"] = json!(args.from_revision);
            (Method::WikiDelta, value)
        }
        WikiSub::Retrieve(args) => (Method::WikiRetrieve, query(&args)?),
    };
    let result: Value = crate::cli::business_rpc::call(
        info.sock_path, "wiki", method, Some(params), TOOL_IPC_TIMEOUT,
    )?;
    match format {
        Format::Json | Format::Human => println!("{}", serde_json::to_string_pretty(&result).map_err(|e| CliError::Local(e.into()))?),
    }
    Ok(())
}

fn scoped(args: &WikiScopeArgs) -> Result<Value, CliError> {
    let mut value = json!({"session_id": args.session_id});
    let explicit = args.page_instance_id.is_some() || args.browser_id.is_some() || args.tab_id.is_some() || args.document_id.is_some() || args.origin.is_some();
    if explicit {
        if args.page_instance_id.is_none() || args.browser_id.is_none() || args.tab_id.is_none() || args.document_id.is_none() || args.origin.is_none() {
            return Err(CliError::Local(anyhow::anyhow!("explicit Wiki scope requires page_instance_id, browser_id, tab_id, document_id, and origin")));
        }
        value["page_instance_id"] = json!(args.page_instance_id);
        value["scope"] = json!(scope(args));
    }
    Ok(value)
}
fn query(args: &WikiQueryArgs) -> Result<Value, CliError> {
    let mut value = scoped(&args.scope)?;
    value["query"] = json!({"ref_id": args.ref_id, "region_id": args.region_id, "since_revision": args.since_revision, "text": args.text, "semantic": args.semantic, "limit": args.limit});
    Ok(value)
}
fn scope(args: &WikiScopeArgs) -> WikiScope { WikiScope { browser_id: args.browser_id.clone().unwrap(), session_id: args.session_id.clone(), tab_id: args.tab_id.unwrap(), document_id: args.document_id.clone().unwrap(), origin: args.origin.clone().unwrap() } }

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    #[derive(Parser)] struct P { #[command(subcommand)] sub: WikiSub }
    #[test]
    fn retrieval_help_shape_is_parseable() {
        let parsed = P::try_parse_from(["bsk", "retrieve", "--text", "invoice", "--semantic"]).unwrap();
        assert!(matches!(parsed.sub, WikiSub::Retrieve(_)));
    }

    #[test]
    fn explicit_scope_is_preserved_for_debug_reads() {
        let parsed = P::try_parse_from(["bsk", "status", "--page-instance-id", "p", "--browser-id", "b", "--tab-id", "1", "--document-id", "d", "--origin", "https://example.test"]).unwrap();
        let WikiSub::Status(args) = parsed.sub else { panic!("expected status") };
        assert_eq!(scoped(&args).unwrap()["page_instance_id"], "p");
    }
}
