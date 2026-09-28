# Wiki retrieval decision policy

Choose the narrowest stable selector that matches the information need. Do not
default to text search or a full snapshot when a stronger selector is already
known.

1. **Known live canonical target / ref** -> `wiki retrieve --ref-id @eN`, only
   for the current page instance. A ref is ephemeral and must not be reused
   after page/snapshot replacement.
2. **Known semantic region** -> `wiki retrieve --region-id <region>`.
3. **Known revision boundary / "what changed?"** -> `wiki delta
   --from-revision N`; use `wiki retrieve --since-revision N` only when asking
   for current evidence constrained by revision. Do not interchange these
   flags.
4. **Known visible text / label but no stronger identity** -> `wiki retrieve
   --text "..."`; add `--semantic` when lexical matching is too narrow. Treat
   matches as evidence candidates, not mutation authority.
5. **Need current page summary/state** -> `wiki current` (discover the active
   page), `wiki status` (freshness/completeness receipt), or `wiki view` (the
   bounded compiled view) before broader retrieval.
6. **No suitable selector, or current materialization insufficient** -> one
   fresh `bsk snapshot --json --quiet` after a meaningful page-state change,
   then retry the narrow query once.
7. **Still insufficient** -> bounded `observe` fallback once; never loop
   `observe`.

Checked against the 0.3.1 CLI: `wiki retrieve` and `wiki view` both accept
`--ref-id` / `--region-id` / `--since-revision` / `--text` / `--semantic` /
`--limit`; `wiki delta` takes `--from-revision`, **requires** it, and has no
`--since-revision`. Every scoped read takes `--session-id <name>`, never
`--session`.

Rules:

- Prefer canonical identity/address/region/revision over free text when
  available.
- Search by text is discovery, not durable identity.
- A stale/incomplete/`not_found`/`full_refresh_required` receipt is control
  information: follow its safe next step; do not blindly widen.
- Never use Wiki as a second identity store or live mutation authority.
- If multiple candidates remain ambiguous, fail closed rather than selecting by
  rank alone.
- For questions about content already present in the canonical projection,
  consume that projection directly before invoking Wiki retrieval.
