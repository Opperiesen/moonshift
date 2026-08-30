# Moonshift Decision Register

**Status:** Normative register for material human, technical, and evidence gates. A `Decided` entry
authorizes only its stated scope; an `Open` entry remains a blocker at its named gate. The human
supervisor owns decisions explicitly marked `Human supervisor`, and evidence must be recorded before
changing a gate to decided. Do not infer a choice from a preferred direction in the founding brief.

| ID | Decision | Owner | Status | Deadline / gate | Options and evidence needed |
|---|---|---|---|---|---|
| OD-001 | Software license | Human supervisor | Open | Before first public release | Compare at least Apache-2.0 and AGPL-3.0 for self-hosting, network use, contributor adoption, and hosted-service implications; obtain legal/product review. **No license is selected here.** |
| OD-002 | Final TypeScript/Go/Rust stack | Engineering; Quality review | Decided 2026-08-31 for slice 001 | Revisit only if measured implementation evidence invalidates the choice | Node.js 24 LTS and pinned TypeScript across browser, control plane, fixture runner, CLI, contracts, and tests. Research R-001/R-012 records the comparison and version evidence. Process/package boundaries preserve a later Go or Rust runner/CLI migration without changing domain contracts. |
| OD-003 | Live transport | Engineering; Quality review | Decided 2026-08-31 for slice 001 | Revisit through a versioned contract change | HTTP commands/queries plus SSE from a durable project-sequenced event projection. Research R-004 and the HTTP/event contracts define reconnect, ordering, at-least-once delivery, cursor reset, and deduplication. Browser acceptance and capacity evidence remain implementation gates, not unresolved design choices. |
| OD-004 | Artifact storage | Engineering; Quality review | Decided 2026-08-31 for slice 001 | Revisit before split or production-like storage | Owner-local content-addressed filesystem bytes behind an artifact interface, with PostgreSQL metadata. Research R-005 defines integrity and backup requirements; S3-compatible storage remains a later adapter option. Restore and capacity evidence remain implementation gates. |
| OD-005 | Runner OCI runtime | Engineering proposal; Human supervisor approval | Open | Before runner-security slice implementation | Compare rootless Podman and equivalent rootless OCI runtimes for cgroups/resource limits, filesystem/network isolation, rootless operation in a dedicated PVE VM, and diagnostics. Evidence: hostile-fixture tests and runner registration probe. |
| OD-006 | Retention policy | Human supervisor | Open | Before first production-like deployment | Set retention for audit events, checkpoints, artifacts, evidence, channel history, and credential metadata; define legal/privacy exceptions, deletion versus archival, backup expiry, and recovery guarantees. Evidence: storage model and restore exercise. |
| OD-007 | Default authentication posture | Human supervisor | Open | Before enabling any real backend by default | Choose default-off versus explicitly configured official API/OAuth/CLI modes; keep API-key, subscription, workspace, and enterprise authentication separate. Evidence: dated vendor compatibility/terms review, credential-isolation test, and failure UX. |
| OD-008 | Public project owner and image namespace | Human supervisor | Open | Before publishing any OCI image or public release | Select the GitHub owner/org and image namespace for `ghcr.io/<owner>/moonshift` and `moonshift-runner`; verify name ownership, governance, signing, and release permissions. |
| OD-009 | Subscription harness terms gate | Human supervisor with dated compatibility review | Open | Before default enablement of Codex, Claude Code, Antigravity, or other subscription modes | For each harness, verify official automation surface, authentication mechanism, credential location, non-interactive/structured output, resume/cancel behavior, and current terms. Mark ambiguous modes unsupported, disabled-by-policy, or experimental requiring review; never scrape or repurpose web sessions. |
| OD-010 | API provider compatibility gate | Engineering proposal; Quality review | Open | Before each model API adapter is described as supported | Record date-stamped evidence for OpenRouter, generic OpenAI-compatible endpoints, native OpenAI/Anthropic/Google APIs, and local endpoints: capabilities, streaming, tools, cancellation, errors, usage, provenance, and conformance results. |
| OD-011 | Reference PVE capacity envelope | Engineering proposal; Human supervisor approval | Open | Before v0.1 capacity claim | Benchmark the 16 GB remote-inference target, including control plane, runner, PostgreSQL/artifacts, three default concurrent cognitive executions, five-run ceiling, and discovered runner capacity. Evidence: repeatable load and recovery measurements. |

## Register rules

An entry may move from `Open` to `Proposed`, `Decided`, or `Deferred` only with an accountable owner,
dated evidence, rationale, compatibility impact, and (where relevant) migration or rollback path.
Terms and compatibility reviews must be refreshed when vendor behavior changes. Product prose should
link to stable IDs or the cited research rather than silently restating a different decision state.
