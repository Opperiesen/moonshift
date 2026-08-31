# Data Model: Supervised Autonomous Loop

**Status**: Phase 1 design
**Feature**: [Supervised Autonomous Loop](spec.md)
**Authority**: The feature specification defines behavior; this document defines the planned durable
model. Provider and framework objects are intentionally absent.

## Modeling rules

- Identifiers are Moonshift-generated opaque UUIDs. Provider, harness, process, and session IDs never
  identify domain entities.
- Every mutable aggregate has an integer version for optimistic concurrency and creation/update times
  in UTC.
- State transitions occur through validated domain commands; repositories do not expose arbitrary
  state assignment.
- Material transitions append an `AuditEvent` and `OutboxEvent` in the same transaction.
- Soft archival preserves provenance. Deletion and retention policy are outside this slice.
- Synthetic fixture usage and effects are labeled; they must not be confused with provider billing or
  real external changes.

## Authority and project aggregates

### Supervisor

| Field | Meaning / constraint |
|---|---|
| `supervisor_id` | Stable Moonshift identity; exactly one active row per instance |
| `display_name` | Local display value; not an external account identity |
| `status` | `ACTIVE` or `DISABLED`; disabling stops new work |
| `created_at` | Audit timestamp |

The Supervisor owns one Workspace in the first slice and is the only actor allowed to decide
approvals or issue project pause/resume/stop/cancel commands.

### Workspace

| Field | Meaning / constraint |
|---|---|
| `workspace_id` | Stable local identity |
| `supervisor_id` | Required owner |
| `name` | `Moonshift` by default |
| `policy_profile_id` | Active validated policy profile |
| `status` | `ACTIVE`, `PAUSED`, or `DISABLED` |

### Project

| Field | Meaning / constraint |
|---|---|
| `project_id` | Stable identity returned for an accepted objective |
| `workspace_id` | Required parent |
| `objective` | Non-empty normalized objective and input hash |
| `fixture_repository_id` | Controlled fixture repository only |
| `status` | `CREATING`, `ACTIVE`, `PAUSING`, `PAUSED`, `RESUMING`, `STOPPING`, `STOPPED`, `CANCELLING`, `COMPLETED`, `BLOCKED`, `FAILED`, `CANCELLED` |
| `policy_profile_id` | Snapshot reference governing limits and approval policy |
| `created_by` | Supervisor identity |
| `version` | Optimistic concurrency token |

An idempotency key on objective submission returns the original Project. `PAUSED` is a graceful,
resumable quiescence; `STOPPED` is a stronger resumable halt after all execution authority is revoked;
`CANCELLED` is terminal. `COMPLETED` requires the configured project result rule rather than only a
verified task.

### Channel

| Field | Meaning / constraint |
|---|---|
| `channel_id` | Stable project-local identity |
| `project_id` | Required parent project |
| `parent_channel_id` | Nullable self-reference; cycle-free |
| `name` | Unique among active siblings after normalization |
| `kind` | `CATEGORY`, `CHANNEL`, or `SUBCHANNEL` |
| `status` | `ACTIVE` or `ARCHIVED` |
| `created_by_agent_id` | Persona or supervisor actor |
| `depth` | Derived/validated, maximum four |

Policy enforces at most 64 active project channels and eight active direct children. Archiving a
parent does not delete descendants or messages.

### CollaborationEvent

| Field | Meaning / constraint |
|---|---|
| `collaboration_event_id` | Stable observable event identity |
| `project_id`, `channel_id` | Required scope |
| `actor_type`, `actor_id` | Supervisor, persona, specialist, or system component |
| `event_kind` | Message, decision summary, status, artifact reference, or system notice |
| `content` | Observable content with classification; never private chain-of-thought |
| `task_id`, `artifact_id` | Optional canonical links |
| `occurred_at` | Durable ordering input |

This record is collaboration evidence, not task or prompt authority.

## Work and organization

### Task

| Field | Meaning / constraint |
|---|---|
| `task_id` | Stable project-scoped identity |
| `project_id` | Required parent |
| `title`, `objective`, `acceptance_criteria` | Bounded work definition |
| `state` | Task state machine below |
| `assignee_agent_id` | Nullable until delegated |
| `authoring_lineage_id` | Prevents same-lineage independent review |
| `verification_policy_id` | Required before execution |
| `expected_revision` | Fixture Git revision used for evidence binding |
| `claimed_at`, `verified_at` | Nullable transition timestamps |
| `version` | Optimistic concurrency token |

### TaskDependency

| Field | Meaning / constraint |
|---|---|
| `task_dependency_id` | Stable project-scoped identity |
| `project_id` | Required shared project for both tasks |
| `predecessor_task_id`, `successor_task_id` | Distinct task identities; unique ordered pair |
| `kind` | `BLOCKS` in slice 001; later kinds require a contract change |
| `created_by` | Authorized Product or Engineering persona, or Supervisor |
| `created_at` | Audit timestamp; the relation is immutable and may be superseded only by an audited command |

The dependency graph is acyclic. A successor cannot become `READY` while an active predecessor is
not `VERIFIED`; dependency state is derived from authoritative Tasks, never from collaboration text.
The reference journey has one task and therefore renders the valid empty dependency state.

### PersonaIdentity

| Field | Meaning / constraint |
|---|---|
| `agent_id` | Stable identity, kind `PERSONA` |
| `project_id` | Required parent |
| `persona_role` | `PRODUCT`, `ENGINEERING`, `QUALITY`, or approved optional role |
| `responsibility` | Versioned role definition reference |
| `policy_profile_id`, `permission_set_id` | Grants independent of runtime |
| `routing_policy_id`, `memory_scope_id` | Stable routing and memory references |
| `lineage_id` | Root organizational lineage |
| `status` | `ACTIVE`, `DISABLED`, or `ARCHIVED`; idle/working/waiting is PresenceProjection state |

There are two to six active personas per project. The default trio is unique by role.

### SpecialistIdentity

| Field | Meaning / constraint |
|---|---|
| `agent_id` | Stable identity, kind `SPECIALIST` |
| `project_id` | Required parent |
| `parent_persona_id` | Active persona; never another specialist in v0.1 |
| `role`, `objective` | Task-scoped identity definition |
| `lineage_id` | Inherits parent authoring lineage |
| `permission_set_id`, `routing_policy_id` | Strict subsets or task-specific constraints |
| `status` | `CREATED`, `ACTIVE`, `PAUSED`, `COMPLETED`, `FAILED`, or `ARCHIVED` |
| `archival_conditions` | Required delegation-derived policy |

Policy enforces four active by default, eight project maximum, and three per-persona maximum.

### Delegation

| Field | Meaning / constraint |
|---|---|
| `delegation_id` | Stable identity; idempotent by task and intended specialist role |
| `project_id`, `task_id` | Required work scope |
| `parent_persona_id`, `specialist_id` | Required lineage |
| `role`, `objective`, `reason` | Bounded purpose |
| `expected_outputs`, `required_evidence` | Structured lists |
| `capability_grant_id`, `budget_id` | Subset leases |
| `max_runtime` | Positive cumulative active-compute budget across all runtime attempts; queued, approval-wait, and capacity-wait time is excluded |
| `task_deadline_at` | Optional absolute task scheduling cutoff; distinct from runtime consumption |
| `termination_conditions`, `archival_conditions` | Required structured policies |
| `status` | `PROPOSED`, `ACTIVE`, `COMPLETED`, `REVOKED`, or `ARCHIVED` |

Delegation depth is derived from lineage and must equal one for specialists.
`max_runtime` exhaustion invokes a termination condition. A short runner/tool/backend lease expiry
removes authority but does not itself exhaust runtime or cancel the Task. Termination conditions decide
when work stops or fails; archival conditions apply only after terminal work has exported required
artifacts, evidence, decisions, and memory proposals.

## Execution resources

### ExecutionBackendDescriptor

| Field | Meaning / constraint |
|---|---|
| `backend_id` | Moonshift identity for a backend implementation |
| `family` | `MODEL_API`, `CODING_HARNESS`, or `LOCAL_RUNTIME` |
| `adapter_name`, `adapter_version` | Implementation provenance; fake adapters only in this slice |
| `status` | `REGISTERED`, `HEALTHY`, `DEGRADED`, `UNAVAILABLE`, or `DISABLED` |
| `conformance_report_id` | Required before eligibility |

### BackendConnection

| Field | Meaning / constraint |
|---|---|
| `connection_id` | Stable configured instance; two fake instances are fixtures |
| `backend_id` | Required descriptor |
| `auth_mode` | `NONE_FIXTURE` only in this slice |
| `credential_reference` | Null for fake backends; never credential material |
| `endpoint_profile` | Fixture profile, independent from agent identity |
| `health`, `last_probed_at` | Scheduling eligibility |
| `max_concurrent_leases` | Validated connection limit |

### ModelDescriptor

| Field | Meaning / constraint |
|---|---|
| `model_descriptor_id` | Stable Moonshift-generated identity; never a provider model string or session ID |
| `backend_id` | Owning backend descriptor; a model descriptor is never owned by one connection |
| `model_key` | Adapter-local immutable fake model key, unique within the backend descriptor |
| `descriptor_version` | Monotonic version of normalized metadata; executions retain the selected version |
| `family`, `modalities` | Provider-neutral fixture classification and bounded input/output modalities |
| `context_limit`, `output_limit` | Synthetic fixture limits with units and provenance |
| `lifecycle` | `ACTIVE` or `RETIRED`; connection eligibility is represented separately |

`model_descriptor_id` plus `descriptor_version` identifies one immutable metadata snapshot. Changing
provider names, sessions, connection configuration, or runtime processes never changes that identity;
a material capability or limit change creates a new version and is auditable.

### ConnectionModelDescriptor

| Field | Meaning / constraint |
|---|---|
| `connection_model_descriptor_id` | Stable identity for one availability assertion |
| `connection_id`, `model_descriptor_id`, `descriptor_version` | Unique connection-to-descriptor-version relation |
| `availability` | `ADVERTISED`, `CONFORMANT`, `UNAVAILABLE`, or `DISABLED`; only `CONFORMANT` may route |
| `conformance_report_id`, `probed_at` | Required evidence and observation time for `CONFORMANT` |

The two fake connections each have a distinct relation to the same backend-scoped descriptor ID and
version. Switching connections changes the relation, runtime, and Execution attempt without cloning
or changing the selected model resource.

### CapabilityDescriptor

| Field | Meaning / constraint |
|---|---|
| `capability_id` | Stable capability identity |
| `connection_id` | Probed connection |
| `name` | e.g. streaming, tools, checkpoint, resume, cancellation, structured result |
| `support` | `SUPPORTED`, `UNSUPPORTED`, or `UNKNOWN` |
| `evidence`, `probed_at` | Conformance evidence reference and time |

### AgentRuntime

| Field | Meaning / constraint |
|---|---|
| `runtime_id` | Ephemeral attempt identity, never an agent identity |
| `agent_id`, `task_id`, `execution_id` | Required logical scope |
| `connection_id`, `model_descriptor_id`, `model_descriptor_version` | Selected fake backend instance and immutable descriptor snapshot |
| `context_manifest_id` | Immutable context input |
| `tool_lease_id`, `budget_lease_id` | Expiring grants |
| `provider_session_hint` | Optional opaque fake hint |
| `status` | Ephemeral runtime lifecycle status; never the logical Agent identity state |
| `fencing_token` | Monotonic token for effect authority; positive and capped at JSON's maximum safe integer for exact runner-protocol transport |

`PresenceProjection` is derived from authoritative identity, Task, Execution, ToolInvocation,
Approval, capacity, and VerificationEvaluation state. It is exactly one of `IDLE`, `QUEUED`,
`THINKING_PROVIDER_CALL`, `USING_TOOLS`, `WAITING_FOR_RUNNER`, `WAITING_FOR_AGENT`,
`WAITING_FOR_APPROVAL`, `VERIFYING`, `BLOCKED`, `COMPLETED`, or `FAILED`. The provider-call label
reveals only that a call is active, never hidden reasoning. Each non-idle projection carries the
source record type/ID, update time, and concise observable activity; projection rebuild cannot alter
authoritative state. The durable `ProjectView` contains the complete current projection for every
active persona and specialist, including a bounded source type/ID and activity. An expired SSE cursor
therefore recovers by reloading `ProjectView` before subscribing from its new `lastSequence`; presence
is never reconstructed from socket liveness or missing event history alone.

### Execution

| Field | Meaning / constraint |
|---|---|
| `execution_id` | One attempt for a task and identity |
| `task_id`, `agent_id`, `runtime_id` | Required references |
| `connection_id`, `model_descriptor_id`, `model_descriptor_version` | Independently retained route and immutable model provenance |
| `state` | Execution state machine below |
| `attempt_number` | Monotonic per task |
| `route_decision_id` | Candidate exclusions and selected connection |
| `started_at`, `ended_at`, `heartbeat_at` | Lease and observability times |
| `normalized_result` | Provider-neutral terminal result reference |
| `normalized_error` | Optional typed failure, no secrets |

### Runner and RunnerLease

| Entity | Required fields / constraints |
|---|---|
| `Runner` | `runner_id`, control-plane `instance_id`, version, health, enrolled certificate serial/status, measured CPU/memory/process/disk/time/network/optional-GPU capabilities, enforcement flags, cgroup/subordinate-ID/rootless-runtime/network/storage-driver/filesystem discovery, last heartbeat; fixture profile only |
| `RunnerLease` | `lease_id`, runner, execution, CPU/memory/process/disk/time/network/GPU request, expiry, monotonic fencing token, status; at most one active fixture effect authority |

The first slice uses a separate runner boundary that exposes only deterministic fixture operations and
never arbitrary shell execution. Its loopback TLS 1.3 transport uses per-instance mutual
authentication. Authenticated certificate identities must match message `instanceId`/`runnerId` before
schema or domain handling; certificate revocation disables the Runner, closes streams, and fences all
leases. The scheduler fails closed if any requested resource control is not reported as enforceable.
The schema records rootless-runtime discovery, but the only eligible slice 001 profile is
`FIXTURE_PROCESS`; no OCI-isolation or second-job claim is inferred from registration.

## Policy, tools, and control

### PolicyProfile and PolicyDecision

`PolicyProfile` versions all organization limits, concurrency limits, approval classes, context
classifications, capability rules, and stop behavior. `PolicyDecision` records policy version, actor,
input digest, allow/deny/approval-required outcome, concise reason codes, and audit correlation.

### ToolCapability and ToolInvocation

`ToolCapability` names one operation, allowed resource scope, argument constraints, expiry, budget,
parent grant, and revocation state. `ToolInvocation` records task/runtime, capability, normalized
arguments and digest, policy decision, approval if required, idempotency key, outcome, and evidence.
The only state-changing tool in the first slice is the controlled fixture effect.

### ApprovalRequest

| Field | Meaning / constraint |
|---|---|
| `approval_id` | Stable request identity |
| `project_id`, `task_id`, `tool_invocation_id` | Required scope |
| `requester_agent_id` | Cannot decide the request |
| `action_digest`, `reason`, `risk_summary` | Immutable presented action |
| `state` | Approval state machine below |
| `expires_at` | Required; expired approval cannot authorize |
| `decided_by`, `decided_at`, `decision_reason` | Supervisor-only terminal decision |
| `version` | Prevents concurrent double decision |

## Outcomes and verification

### Artifact

| Field | Meaning / constraint |
|---|---|
| `artifact_id` | Stable identity |
| `project_id`, `task_id`, `execution_id` | Required provenance |
| `kind`, `media_type`, `size` | Validated fixture metadata |
| `content_hash`, `storage_key` | Integrity and storage interface key |
| `git_revision` | Required expected revision |
| `created_by_agent_id`, `created_at` | Attribution |

The owner-local adapter durably publishes bytes before metadata using unique temporary files,
file/directory fsync barriers, and no-replacement content-addressed links. Concurrent identical
byte publications converge on one storage object, while each stable `artifact_id` retains an
independent metadata sidecar so identical bytes with different provenance remain distinct artifacts.
Partial bytes-only or metadata-link publication is recoverable by retry before the artifact is
acknowledged.

### Evidence

| Field | Meaning / constraint |
|---|---|
| `evidence_id` | Stable observation identity |
| `task_id`, `artifact_id` | Required task; artifact optional by rule |
| `evidence_type` | Build, test, integrity, coverage, review, approval, or reconciliation |
| `status` | `PASS`, `FAIL`, `MISSING`, `STALE`, or `BLOCKING` |
| `git_revision`, `source_hash` | Ground-truth binding |
| `producer`, `observed_at` | Attribution |

### VerificationPolicy, VerificationRule, VerificationEvaluation

The policy versions an ordered rule set. Each rule declares required evidence type, acceptable
status, revision binding, independence constraint, and blocking behavior. An evaluation records the
exact policy version, immutable evidence IDs and hashes, expected Git revision, snapshot hash,
per-rule results, Quality reviewer lineage, aggregate result, and transition decision. Its lifecycle is
`EVALUATING`, `PASSED`, `FAILED`, or `STALE`. Immediately before committing a decision, the engine
compares the current policy/revision/evidence-set hash with the captured snapshot. Any new, replaced,
removed, reclassified, or hash-mismatched evidence makes the evaluation `STALE`, emits an attributable
event, prevents a Task transition, and queues a fresh evaluation against a new immutable snapshot.
Only a non-stale aggregate pass may transition the task to `VERIFIED`.

Pause has an explicit verification interlock. Accepting pause moves the Project to `PAUSING`, blocks
new evaluations, and lets an already `EVALUATING` snapshot reach one bounded safe boundary while the
Project remains `PAUSING`. The pause coordinator cannot commit `PAUSED` until each such evaluation has
either atomically compare-and-committed its terminal outcome and optional Task transition, or has been
marked `STALE` with no Task transition when the grace boundary expires. No
`VERIFYING` to `VERIFIED` transition may commit while the Project is `PAUSED`; resume queues a fresh
evaluation for any stale snapshot. A passing evaluation committed during `PAUSING` may verify its
Task but cannot promote the Project to `COMPLETED`; after resume the project-result rule is reevaluated.

### ExternalEffect

| Field | Meaning / constraint |
|---|---|
| `effect_id` | Stable semantic identity |
| `project_id`, `task_id`, `tool_invocation_id` | Required scope |
| `idempotency_key`, `action_digest`, `target` | Unique intended fixture operation |
| `state` | External effect state machine below |
| `executor_execution_id`, `executor_lease_id`, `executor_owner_id`, `executor_fencing_token` | Persisted current lease authority; the runtime actor must match the owner, and verification plus the `REQUESTED` → `EXECUTING` commit serialize atomically with lease expiry/revocation/replacement |
| `ground_truth_reference` | Fixture location queried by reconciliation |
| `attempt_count`, `last_error` | Bounded retry evidence |
| `reconciliation_outcome` | Applied/not-applied/indeterminate with evidence |

### ExecutionCheckpoint

An immutable checkpoint stores task and agent references, source execution and connection, objective
and acceptance snapshot, task state, decision summaries, open questions, repository revision and diff
state, artifact/evidence/tool references, remaining work, context manifest, budgets and leases,
external effects and reconciliation status, optional session hint, schema version, hash, and creation
reason.

## Context, usage, and audit

### ContextManifest and ContextManifestItem

The manifest records execution, task, agent, selected backend connection, compiler policy version,
destination, size, hash, and creation time. Items record source type/reference/revision, content hash,
classification, inclusion reason, transformation/redaction, and order. Credentials and raw chat
history cannot be manifest inputs.

### Budget and UsageRecord

Budget records parent scope, invocation/quota limits, optional monetary limit, consumed values,
reservation, expiry, and status. Usage records backend connection, execution, explicitly synthetic
invocations/units/cost, source, and timestamp. A child reservation cannot exceed available parent
budget.

### AuditEvent and OutboxEvent

`AuditEvent` records immutable event ID, aggregate type/ID/version, actor, action, target, reason code,
outcome, correlation and causation IDs, occurred/recorded times, and sanitized metadata. `OutboxEvent`
stores the public domain-event envelope and delivery status in the same transaction. Project sequence
numbers provide deterministic browser ordering; consumers deduplicate by event ID.

## State transitions

### Project

| From | Allowed next states | Authorized cause |
|---|---|---|
| `CREATING` | `ACTIVE`, `FAILED`, `CANCELLING` | Atomic bootstrap system result or Supervisor cancellation |
| `ACTIVE` | `PAUSING`, `STOPPING`, `CANCELLING`, `COMPLETED`, `BLOCKED`, `FAILED` | Supervisor control or validated system/result rule |
| `PAUSING` | `PAUSED`, `STOPPING`, `CANCELLING`, `BLOCKED`, `FAILED` | Scheduler safe-boundary result or Supervisor control |
| `PAUSED` | `RESUMING`, `STOPPING`, `CANCELLING` | Supervisor command only |
| `RESUMING` | `ACTIVE`, `STOPPING`, `CANCELLING`, `BLOCKED`, `FAILED` | Scheduler recovery result or Supervisor control |
| `STOPPING` | `STOPPED`, `CANCELLING`, `BLOCKED`, `FAILED` | Revocation/fencing and effect reconciliation coordinator |
| `STOPPED` | `RESUMING`, `CANCELLING` | Supervisor command only; resume mints entirely new authority |
| `CANCELLING` | `CANCELLED`, `BLOCKED` | Cancellation coordinator after effect ground truth is known |
| `BLOCKED` | `ACTIVE`, `PAUSING`, `STOPPING`, `CANCELLING`, `FAILED` | Explicit remediation/reconciliation or Supervisor control |
| terminal (`COMPLETED`, `FAILED`, `CANCELLED`) | none | Repair requires a new audited project/task command, not mutation of terminal history |

Pause, stop, and cancel serialize on the Project version. Pause prevents new leases, checkpoints
cooperative work, preserves pending approvals, and converges to `PAUSED`; an effect already
`EXECUTING` may only finish and record ground truth. Stop additionally cancels pending approvals,
revokes all execution-scoped capabilities, fences runner/backend authority, ends affected Executions
as `STOPPED`, and converges to resumable `STOPPED` only after reconciliation. Cancel uses the same
revocation boundary, cancels unfinished Tasks, and converges to terminal `CANCELLED`. If completion
commits first, a stale stop/cancel command conflicts; if stop/cancel commits first, later completion is
rejected. Repeating the same idempotency key returns the original result; a new key against an already
stable or terminal state is a conflict, never a second transition.

### Task

| From | Allowed next states | Authorized cause |
|---|---|---|
| `PROPOSED` | `READY`, `CANCELLED` | Product/Engineering definition or supervisor cancel |
| `READY` | `QUEUED`, `BLOCKED`, `CANCELLED` | Scheduler/policy/supervisor |
| `QUEUED` | `RUNNING`, waiting states, `BLOCKED`, `CANCELLED` | Scheduler and capacity/agent/approval state |
| `RUNNING` | waiting states, `BLOCKED`, `CLAIMED_COMPLETE`, `FAILED`, `CANCELLED` | Runtime/system/supervisor |
| waiting states | `QUEUED`, `RUNNING`, `BLOCKED`, `FAILED`, `CANCELLED` | Resolved dependency/policy/supervisor |
| `CLAIMED_COMPLETE` | `VERIFYING`, `BLOCKED`, `CANCELLED` | Verification scheduler/system |
| `VERIFYING` | `VERIFIED`, `BLOCKED`, `FAILED`, `CANCELLED` | Verification Engine only for `VERIFIED` |
| terminal | none | New repair work creates a new attempt/transition path by explicit command |

The Verification Engine serializes its final compare-and-commit with Project control state. It may
commit `VERIFYING` to `VERIFIED` during `PAUSING` only before the pause coordinator commits `PAUSED`;
otherwise the evaluation becomes `STALE`, makes no Task transition, and is reevaluated after resume.
Project completion is deferred while `PAUSING` even when that Task transition succeeds.

### Execution

| From | Allowed next states | Authorized cause |
|---|---|---|
| `QUEUED` | `STARTING`, `SUSPENDED`, `STOPPING`, `CANCELLED` | Scheduler lease, pause, stop, or cancellation coordinator |
| `STARTING` | `RUNNING`, `SUSPENDED`, `STOPPING`, `FAILED`, `CANCELLED`, `LOST` | Runtime handshake, control, startup failure, or lease monitor |
| `RUNNING` | `WAITING_FOR_APPROVAL`, `CHECKPOINTING`, `SUSPENDED`, `STOPPING`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `LOST` | Policy/tool boundary, pause checkpoint, stop, runtime result, cancellation, or lease monitor |
| `WAITING_FOR_APPROVAL` | `RUNNING`, `SUSPENDED`, `STOPPING`, `FAILED`, `CANCELLED`, `LOST` | Valid decision, pause, stop, expiry/failure, cancellation, or lease monitor |
| `CHECKPOINTING` | `RUNNING`, `SUSPENDED`, `STOPPING`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `LOST` | Checkpoint result, pause, stop, runtime result, cancellation, or lease monitor |
| `SUSPENDED` | none; resume creates a successor Execution from the checkpoint | Completed pause coordinator only |
| `STOPPING` | `STOPPED`, `RECONCILING`, `FAILED` | Stop coordinator after lease revocation/fencing |
| `STOPPED` | none; resume creates a successor Execution from the checkpoint | Completed stop coordinator only |
| `LOST` | `RECONCILING` | Recovery coordinator only after fencing the old runtime |
| `RECONCILING` | `SUCCEEDED`, `FAILED`, `STOPPED`, `CANCELLED` or a successor Execution from checkpoint | Reconciliation ground truth and current Project control intent |

### Approval

`REQUESTED` may become exactly one of `APPROVED`, `REJECTED`, `EXPIRED`, or `CANCELLED`. Terminal
states never change. Only the authenticated Supervisor may approve or reject; the expiry worker may
expire; project stop/cancel may cancel, while pause preserves the request but prevents it from being
used. The action digest, aggregate version, expiry, current Project state, and policy are checked again
when applying an approval.

### External effect

| From | Allowed next states | Authorized cause |
|---|---|---|
| `REQUESTED` | `EXECUTING`, `FAILED` | Current fenced runner lease after policy/approval recheck, or policy failure |
| `EXECUTING` | `APPLIED`, `FAILED`, `UNKNOWN` | Runner result or recovery timeout/loss detector |
| `UNKNOWN` | `RECONCILING` | Recovery coordinator after fencing uncertain authority |
| `RECONCILING` | `RECONCILED`, `UNKNOWN` | Ground-truth reconciler only |
| terminal | none | `RECONCILED` records the actual success/failure ground-truth outcome |

## Integrity and concurrency invariants

1. One accepted objective command and idempotency key maps to one Project.
2. One active default persona exists for each of Product, Engineering, and Quality.
3. Every Specialist has exactly one parent Persona and delegation depth one.
4. A permission or budget child grant is never greater than its parent.
5. Quality reviewer lineage differs from Task authoring lineage.
6. One semantic effect key maps to one ExternalEffect regardless of execution attempt.
7. Only the current fencing token may move an effect from `REQUESTED` to `EXECUTING`; durable lease
   and claim validity is decided against the PostgreSQL clock, never a caller-supplied timestamp.
8. An approval authorizes only its exact action digest before expiry.
9. Only a complete passing VerificationEvaluation for the expected Git revision may create
   `VERIFIED`.
10. Audit and outbox records share the committed aggregate version that caused them.
11. A context item is disclosed only when classification permits the selected destination.
12. No provider session hint participates in a domain uniqueness or foreign-key constraint.
13. A `DISABLED` Supervisor or Workspace cannot authorize commands or mint or renew authority.
    Disabling either stops new scheduling, revokes renewable leases, and requires existing effects to
    reach a safe reconciled boundary; re-enablement is an audited administration action outside
    slice 001.
14. Runner messages are rejected before domain handling unless the mutual-TLS identities, instance,
    runner enrollment, certificate status, message identity, lease, execution, and fence all match.
15. Only allowlisted sanitizer output may enter audit, outbox, SSE, evidence, error, or UI projections;
    raw backend objects are never persisted or published.
16. A VerificationEvaluation cannot commit against a different policy, revision, evidence set, or
    content hash than its captured snapshot; it becomes `STALE` and produces no Task transition.
17. A `ModelDescriptor` is backend-scoped and connection-independent; route eligibility requires a
    current `CONFORMANT` ConnectionModelDescriptor relation for the exact retained descriptor version.
18. An Execution retains both its selected connection and descriptor ID/version; switching connections
    creates a successor Execution without changing the logical descriptor snapshot.
19. `PAUSED` has no `EVALUATING` verification and permits no new `VERIFIED` transition; pause and the
    verification compare-and-commit serialize through the `PAUSING` safe boundary.
