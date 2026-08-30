# Moonshift Glossary

**Status:** Normative terminology. Definitions are domain contracts and must remain provider-neutral. Examples are non-normative. The constitution is authoritative where a definition conflicts with a principle.

## Identity and execution

### PersonaIdentity
**Normative:** A durable project-level agent identity with stable role, responsibility, policies, permissions, memory references, performance/evaluation history, and routing policy. It is not a model, provider account, SDK object, session, process, container, or conversation ID.

### SpecialistIdentity
**Normative:** A temporary, task-scoped agent identity created under policy by a persona for a defined objective, outputs, evidence, capabilities, time, and budget. In v0.1 it cannot create child agents and is normally archived after exporting its artifacts, evidence, decisions, and memory proposals.

### AgentRuntime
**Normative:** An ephemeral execution instance that binds an identity to a selected backend, model or harness, compiled context, tool lease, budget lease, and process/session. Replacing it must preserve logical identity and authoritative state.

### ExecutionBackend
**Normative:** Moonshift's provider-neutral boundary for an executable cognitive or local resource. It is a family, not an identity: `ModelApiBackend`, `CodingHarnessBackend`, and `LocalRuntimeBackend` are distinct families. Provider SDK request/response types must not escape this boundary.

### BackendConnection
**Normative:** A configured, auditable connection to one execution backend, including official authentication mode, opaque credential reference, health/capability status, ownership, expiry, and policy metadata. API-key, subscription, workspace, and enterprise modes remain distinct. The connection is not an agent identity.

### ModelDescriptor
**Normative:** Provider-neutral metadata describing a model resource: stable Moonshift identifier, provider/family provenance, context and output characteristics, supported modalities, pricing or quota metadata where authoritative, and compatibility/version information. It is a routing resource, not a persona.

### CapabilityDescriptor
**Normative:** Provider-neutral declaration of what a backend or connection can do, such as structured output, streaming, tool calls, cancellation, checkpoint recovery, artifact collection, or usage accounting, including support status and conformance evidence. A claimed capability is not support until conformance passes.

## Context, outcomes, and state

### ContextManifest
**Normative:** The record for a compiled cognitive context: selected inputs, selection reasons, provenance, hashes, classifications, permissions, and external destinations. It proves minimized disclosure and does not contain private chain-of-thought.

### Evidence
**Normative:** An attributable, revision- or effect-bound observation used by deterministic verification: tests, build outputs, artifacts, reviews, security results, requirement coverage, or reconciliation results. Prose confidence is not evidence.

### Artifact
**Normative:** A durable, addressable output of work or verification, such as a patch, report, package, specification, test result, or evidence bundle, with provenance and integrity metadata. An artifact is not automatically proof of completion.

### checkpoint
**Normative:** A provider-neutral durable snapshot allowing a logical task to recover or switch runtime. It includes objective/acceptance criteria, task state, decisions, artifacts, repository revision/diff, tool results, tests/evidence, remaining work, context manifest, and external-effect reconciliation state. Provider conversation/session IDs are optional hints only.

### external effect
**Normative:** A material change visible outside the current runtime, such as a Git push, pull-request operation, artifact publication, or external service mutation. It has stable idempotency identity, durable intent, lifecycle, audit, and reconciliation. Its state machine distinguishes requested, executing, applied, failed, unknown, reconciling, and reconciled.

### verification
**Normative:** Deterministic evaluation that may promote a task from `CLAIMED_COMPLETE` to `VERIFIED` only when the configured evidence policy passes. `Done` is computed from evidence, never inferred from an agent message.

## Methods and authority

### DevelopmentMethod
**Normative:** A replaceable domain boundary for the development lifecycle: assess, constitute, specify, clarify, plan, decompose, analyze, implement, verify, and converge. Spec Kit is the first implementation; Moonshift must not make its domain permanently dependent on it.

### Supervisor
**Normative:** The exactly-one human root authority for a v0.1 self-hosted instance. The supervisor controls objectives, policies, budgets, approvals, credentials references, pause/stop/revoke decisions, and release choices. No agent, backend, runtime, or policy may override the supervisor.

## Related terms

**Project**, **Task**, **Runner**, **RunnerLease**, **ToolCapability**, **ToolInvocation**, **ApprovalRequest**, **PolicyDecision**, **UsageRecord**, **Budget**, **AuditEvent**, and **MemoryRecord** are additional core concepts named by the founding brief. Their detailed contracts belong in the relevant feature specifications and architecture documents; this glossary intentionally avoids duplicating those documents.
