# Moonshift Feature Map

**Status:** Normative staged roadmap; slice names and separation of concerns are commitments, while implementation details remain non-normative until their feature specifications and plans are approved. The product vision is [`product-vision.md`](product-vision.md); detailed contracts belong in each slice's Spec Kit artifacts.

The roadmap contains exactly twelve staged slices. Each slice must be independently demonstrable, testable, evidence-bearing, and bounded by explicit exclusions. Later slices must not silently pull forward their concerns.

| Order | Slice | Scope and outcome |
|---:|---|---|
| 001 | `001-supervised-autonomous-loop` | End-to-end walking skeleton: two interchangeable deterministic fake connections behind the minimum versioned backend/model boundary, Product/Engineering/Quality personas, bounded specialist delegation, channels, approval, durable state, evidence, restart/recovery, and live UI. The fake minimum is not general provider conformance. |
| 002 | `002-execution-backend-contracts` | Generalize the slice 001 fake minimum into backend-family request/event/result contracts, model discovery, capability probing, conformance framework, routing, usage, health, checkpoint handling, and an expanded deterministic compatibility corpus suitable for later real adapters. |
| 003 | `003-model-api-backends` | OpenRouter profile, generic OpenAI-compatible endpoints, native OpenAI/Anthropic/Google adapters, and compatible local endpoints behind the model-API family. |
| 004 | `004-coding-harness-backends` | Codex, Claude Code, Antigravity subject to current terms, Gemini CLI API/enterprise modes, generic harness SDK, credential homes, structured execution, cancellation, and resumption. |
| 005 | `005-organization-engine` | Policy-driven personas and specialists, delegation and quotas, nested channels, task dependencies, lifecycle, capacity limits, and archival. |
| 006 | `006-runner-security-and-tools` | Isolated runner, capability gateway, MCP boundary, worktrees, resource scheduling, network policies, approvals, credential isolation, and effect reconciliation. |
| 007 | `007-autonomous-software-loop` | Spec Kit-driven objective-to-verified-branch workflow in a real repository, with revision-bound evidence and independent review. |
| 008 | `008-context-and-memory` | Context compiler, hierarchical memory, provenance, privacy/classification rules, retrieval, compaction, and reviewable memory proposals. |
| 009 | `009-supervisor-console` | Operations dashboard for organization graphs, tasks, providers, budgets/quotas, approvals, results, pause/stop, and recovery. |
| 010 | `010-pve-deployment-and-releases` | Proxmox-oriented all-in-one and split bundles, backup/restore, upgrade/rollback, OCI releases, SBOM, health, diagnostics, and resource validation. |
| 011 | `011-evaluation-and-organizational-learning` | Outcome metrics, routing evaluation, versioned personas, proposed specialists, and controlled promotion through bounded evaluations and human approval. |
| 012 | `012-remote-agent-interoperability` | A2A or a future standard for remote-agent interoperability, only after the local core is stable and its boundaries are proven. |

## Sequencing rules

Slice 001 is the first implementation target and must use deterministic fakes, no real subscription credentials, no unrestricted shell, no production deployment, no multi-user functionality, no semantic long-term memory, no recursive specialist spawning, and no autonomous self-improvement. The [open-decision register](open-decisions.md) records choices that may gate later slices; it does not alter this ordering.
