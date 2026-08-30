# Feature Specification: Supervised Autonomous Loop

**Feature Branch**: `main` (Iteration 0 planning; the feature directory is authoritative)

**Created**: 2026-08-30

**Status**: Planned, independently reviewed, and decomposed; ready for bounded T001–T024 implementation

**Input**: Founding vertical slice for an observable, durable, policy-bounded autonomous software
loop using deterministic fake execution and objective verification.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start and Observe a Bounded Project (Priority: P1)

As the supervisor, I submit a software objective and see Moonshift create the smallest default
organization, structure a bounded task, delegate it to a temporary specialist, and execute a
deterministic fake run while observable events appear in the browser.

**Why this priority**: This proves that Moonshift is an organization and control plane rather than a
chat wrapper. It establishes the identity, delegation, policy, execution, and live-observation path on
which every later story depends.

**Independent Test**: Start from a fresh local installation and a controlled fixture repository,
submit one objective, and observe a durable project with Product, Engineering, and Quality personas,
at least one nested project channel, one Engineering delegation, one temporary specialist, one fake
backend run, and an ordered activity stream.

**Acceptance Scenarios**:

1. **Given** a fresh instance with available capacity, **When** the supervisor submits a valid
   objective, **Then** exactly one project is created with a stable identity and visible status.
2. **Given** the new project, **When** initialization completes, **Then** Product, Engineering, and
   Quality personas exist as stable identities unrelated to any backend instance or session.
3. **Given** project policy permits the default organization, **When** Engineering decomposes the
   objective, **Then** at least one project channel or sub-channel and one bounded task are created.
4. **Given** the bounded task, **When** Engineering delegates it, **Then** one temporary specialist is
   created with recorded objective, rationale, outputs, evidence, capabilities, time, budget, and
   archival conditions.
5. **Given** the specialist is scheduled, **When** deterministic fake execution runs, **Then** ordered
   organization and execution events become visible without exposing private chain-of-thought.
6. **Given** an invalid objective or exhausted organizational capacity, **When** submission or
   delegation is attempted, **Then** no partial unauthorized organization is created and the
   supervisor sees an actionable rejection.

---

### User Story 2 - Govern Sensitive and Stoppable Work (Priority: P2)

As the supervisor, I see a simulated sensitive tool action become an approval request and can approve,
reject, or stop execution without the action bypassing policy.

**Why this priority**: Human sovereignty is meaningful only when sensitive effects wait for an
explicit, auditable decision and stop controls revoke further work.

**Independent Test**: Run a scripted specialist scenario that requests one sensitive simulated
effect. Verify that the effect remains unapplied before approval, that approve and reject produce
different terminal outcomes, and that stop prevents any new tool intent or effect execution for the
revoked execution while still allowing attributable reconciliation records for work already in flight.

**Acceptance Scenarios**:

1. **Given** a running specialist requests a sensitive action, **When** policy evaluates the request,
   **Then** an approval bound to the exact action is created and the effect is not applied.
2. **Given** a pending approval, **When** the supervisor approves it before expiry, **Then** the
   simulated effect is applied at most once and the decision and result are auditable.
3. **Given** a pending approval, **When** the supervisor rejects or the request expires, **Then** the
   effect is not applied and the execution follows its defined blocked or failed path.
4. **Given** a queued or running execution, **When** the supervisor stops it, **Then** further
   execution and tool leases are revoked, pending approvals are cancelled, safe state is checkpointed,
   and any uncertain effect is reconciled before the recoverable project state becomes `STOPPED`.
5. **Given** an approval payload is changed after presentation, **When** execution is attempted,
   **Then** the prior approval is invalid and a new request is required.
6. **Given** completion races with stop or cancel, **When** the commands serialize on the Project
   version, **Then** the first committed transition wins, stale completion/controls are rejected, stop
   remains explicitly resumable, and cancel remains terminal.

---

### User Story 3 - Verify Claims with Independent Evidence (Priority: P3)

As the supervisor, I see a specialist publish an artifact and claim completion, while independent
Quality evaluation and deterministic evidence rules decide whether the task is actually verified.

**Why this priority**: Moonshift's central promise is verifiable software delivery; an agent's claim
must never equal completion.

**Independent Test**: Execute one passing and one failing deterministic evidence fixture. Both
specialists claim completion and publish an artifact; only the passing revision reaches `VERIFIED`,
and Quality is demonstrably outside the authoring lineage.

**Acceptance Scenarios**:

1. **Given** a specialist publishes an attributable artifact, **When** it claims completion, **Then**
   the task enters `CLAIMED_COMPLETE` and cannot directly become `VERIFIED`.
2. **Given** a claimed task, **When** Quality begins independent evaluation, **Then** the task enters
   `VERIFYING` and records a reviewer outside the Engineering authoring lineage.
3. **Given** all required deterministic evidence passes and is bound to the expected fixture Git
   revision, **When** verification evaluates the policy, **Then** the task enters `VERIFIED` with a
   complete evidence decision.
4. **Given** required evidence is missing, failing, stale, bound to another revision, or reviewed by
   the authoring lineage, **When** verification evaluates the policy, **Then** the task does not enter
   `VERIFIED` and the blocking reasons are visible.
5. **Given** Quality captured an evidence snapshot, **When** evidence, its hash, the expected revision,
   or the verification policy changes before decision commit, **Then** that evaluation becomes
   `STALE`, produces no task transition, and a fresh evaluation is required.

---

### User Story 4 - Recover Without Losing or Duplicating Work (Priority: P4)

As the supervisor, I can pause and resume the project, restart the control plane, or lose an agent
runtime and still retain authoritative state without duplicating an external effect.

**Why this priority**: Autonomous work that cannot survive routine interruption is unsafe and cannot
be supervised reliably.

**Independent Test**: Pause and restart at scripted boundaries before, during, and after the simulated
effect. Restore the same project and task, reconcile the effect exactly once, then resume the same
specialist identity on a different fake backend instance from a provider-neutral checkpoint.

**Acceptance Scenarios**:

1. **Given** an active project, **When** the supervisor pauses it, **Then** no new execution starts,
   active work reaches a defined safe state, and the project can later resume.
2. **Given** committed project activity, **When** the control plane restarts, **Then** all authoritative
   identities, channels, tasks, approvals, events, artifacts, evidence, checkpoints, and effects
   reappear with the same stable identities.
3. **Given** a runtime is lost before, during, or after a simulated effect, **When** recovery runs,
   **Then** the effect is reconciled against its durable fixture state and is never applied twice.
4. **Given** a valid checkpoint and a second conformant fake backend instance, **When** the original
   runtime is unavailable, **Then** the same specialist and task resume with unchanged authoritative
   identity, history, worktree, artifacts, and evidence.
5. **Given** recovery cannot determine an effect outcome, **When** reconciliation exhausts its safe
   policy, **Then** the effect remains `UNKNOWN` or reconciling and the project blocks for supervisor
   attention rather than retrying blindly.

---

### User Story 5 - Inspect a Complete Result and Audit Trail (Priority: P5)

As the supervisor, I can inspect the final task, artifact, evidence, approval history, backend run,
organization activity, and audit timeline from one result surface.

**Why this priority**: A technically correct run is not supervisable unless its outcome and provenance
are legible to the human root authority.

**Independent Test**: Load the result for a completed fixture project after a browser reconnect and
confirm that every required record is visible, consistently identified, ordered, and linked to the
expected revision and task.

**Acceptance Scenarios**:

1. **Given** a verified project task, **When** the supervisor opens Results, **Then** the task,
   artifact, evidence decision, approval history, backend execution, and audit timeline are present.
2. **Given** a paused, stopped, failed, cancelled, blocked, or unverified project/task, **When** Results
   is opened, **Then** its actual control/task state and blocking evidence are shown without presenting
   it as done.
3. **Given** live events were missed during disconnection, **When** the browser reconnects, **Then** it
   restores an ordered projection from durable state without gaps or duplicate visible events.

### Edge Cases

- The submitted objective is empty, exceeds configured input limits, or contains untrusted
  instructions that request capabilities outside the feature fixture.
- Default personas cannot all be created because policy ceilings are misconfigured or already
  exhausted.
- A persona requests a child specialist beyond delegation depth one, its permission subset, budget,
  time, per-persona limit, or project limit.
- Two commands repeat the same objective, delegation, approval decision, stop request, or effect key.
- An approval is decided concurrently, arrives after expiry, or refers to a different action digest.
- The supervisor pauses while a runtime is waiting for approval or verifying evidence.
- Event delivery disconnects, reconnects from an old cursor, or receives the same event more than once.
- The control plane stops after recording effect intent but before result, or after applying the
  fixture effect but before recording success.
- A checkpoint is missing, corrupt, incompatible, or references artifacts whose hashes do not match.
- The replacement fake backend lacks a capability required by the remaining task.
- Artifact bytes are missing, altered, oversized, or bound to a different task or revision.
- Quality is accidentally assigned from the Engineering lineage or an immutable evidence-set snapshot
  changes during review; the in-progress evaluation must become stale rather than decide on mixed data.
- Runner or cognitive capacity is exhausted while the organization remains within identity limits.
- The stop command races with fake backend completion or tool output.
- A forged, replayed, revoked-certificate, identity-mismatched, or plaintext runner message reaches the
  authenticated runner boundary.
- Backend output includes an unknown field, credential-shaped value, absolute/traversal path, raw
  transcript, authorization header, or private-reasoning field.

## Requirements *(mandatory)*

### Functional Requirements

#### Project and organization

- **FR-001**: The system MUST allow the single supervisor to submit one high-level software objective
  through the browser and receive exactly one durable project identity for an accepted submission.
- **FR-002**: The system MUST reject invalid objectives without creating an undisclosed partial
  project and MUST show an actionable reason.
- **FR-003**: An accepted project MUST create Product, Engineering, and Quality as persistent persona
  identities independent of backend, model, provider, process, and session identifiers.
- **FR-004**: The system MUST enforce the v0.1 organization policy: two to six personas, four active
  specialists by default and eight maximum, two specialists per persona by default and three maximum,
  and delegation depth exactly one.
- **FR-005**: A permitted persona MUST be able to create and archive nested project channels subject
  to 24 active channels by default, 64 maximum, depth four, and eight direct children per channel.
- **FR-006**: Messages and collaboration activity MUST be observable and attributable but MUST NOT be
  treated as canonical task state or forwarded wholesale as execution context.
- **FR-007**: Engineering MUST create one bounded task and delegate it to one temporary specialist
  with every required delegation field: parent, project, task, role, objective, rationale, outputs,
  evidence, capabilities, runtime, quota/invocation and measurable monetary budgets, and termination
  and archival conditions. Cumulative active-compute maximum runtime, optional absolute task deadline,
  short authority-lease expiry, termination conditions, and post-terminal archival conditions MUST be
  represented and enforced as distinct concepts.
- **FR-008**: Delegation MUST fail when it exceeds the parent's permissions or budget, any organization
  ceiling, capacity policy, or depth one, and the specialist MUST NOT create child agents.

#### Execution and observation

- **FR-009**: The specialist MUST execute only through a deterministic fake execution backend against
  a controlled fixture repository, with no real subscription credential, unrestricted shell, or
  unapproved external network effect. The separate fixture runner MUST use mutually authenticated
  per-instance transport, bind every message to enrolled instance/runner identities, reject replay or
  revoked identity before domain handling, and fence all leases on revocation.
- **FR-010**: The same scripted input and starting state MUST produce the same normalized fake backend
  events, tool intents, artifact, and evidence outcome.
- **FR-011**: The system MUST model agent identity, runtime, backend descriptor, backend connection,
  model descriptor and version, and optional backend session as separate identities with
  Moonshift-owned stable identifiers. Model descriptors MUST be backend-scoped resources independent
  of connections; per-connection availability/conformance MUST be a separate relation, and every
  Execution MUST retain its selected connection plus exact descriptor ID/version.
- **FR-012**: The browser MUST expose ordered observable project, organization, execution, tool,
  approval, verification, and recovery events and distinguish every presence state defined in the
  product vision. The durable project query MUST return every active agent's current bounded presence
  source projection so an expired event cursor can reload it without inferring state from a socket.
- **FR-013**: Observable output MUST include decisions, concise rationale, tool activity, state,
  artifacts, and evidence while excluding private chain-of-thought. Untrusted backend output MUST pass
  a kind-specific, bounded allowlist projection before persistence or publication; unknown fields,
  raw transcripts/prompts, credentials, authorization material, and host-sensitive paths MUST be
  rejected rather than logged or forwarded.
- **FR-014**: The system MUST enforce three concurrent cognitive executions by default and MUST remain
  correct up to the configured v0.1 ceiling of five; queued work MUST state whether it waits for a
  backend, cognitive capacity, runner capacity, another agent, or approval.

#### Policy, approval, and control

- **FR-015**: Every tool request MUST be evaluated against the specialist capability lease and current
  policy before execution.
- **FR-016**: A simulated sensitive effect MUST create a durable approval request bound to an immutable
  action digest, requester, scope, reason, expiry, and idempotency identity and MUST NOT execute first.
- **FR-017**: Only the supervisor may approve or reject the request; a changed, expired, rejected, or
  cancelled request MUST NOT authorize the effect.
- **FR-018**: Approval decisions, policy decisions, attempts, and outcomes MUST produce attributable
  audit events.
- **FR-019**: The supervisor MUST be able to pause, resume, stop, and cancel project execution with
  distinct durable semantics. Pause MUST prevent new leases, checkpoint cooperative work, preserve
  pending approvals without allowing their use, and reach resumable `PAUSED`. Stop MUST cancel pending
  approvals, revoke execution capabilities, fence runner/backend authority, reconcile effects, end
  affected attempts, and reach resumable `STOPPED`; resume MUST mint new authority and a successor
  execution. Cancel MUST use the same safe revocation/reconciliation boundary, cancel unfinished work,
  and reach terminal `CANCELLED`. Commands MUST be versioned, idempotent, and deterministic under a
  race with completion. Pause MUST serialize with verification: no new evaluation starts after
  `PAUSING`; an in-flight evaluation either compare-and-commits before `PAUSED` or becomes `STALE`
  without a Task transition, `PAUSED` permits no `VERIFYING` to `VERIFIED` commit, and a Task verified
  during `PAUSING` MUST NOT promote its Project to `COMPLETED` until completion is reevaluated after
  resume.
- **FR-020**: No identity or runtime may self-approve, increase its own grant, bypass policy, or count
  as an independent reviewer of its own authoring lineage.

#### State, effects, and recovery

- **FR-021**: The system MUST durably implement the Task, Execution, Approval, and External Effect
  states named in the product foundation plus the Project pause/stop/cancel states, with explicit
  validated transitions, terminal behavior, and actor authority.
- **FR-022**: An agent claim MUST transition a running task at most to `CLAIMED_COMPLETE`; only the
  deterministic Verification Engine may transition `VERIFYING` to `VERIFIED`.
- **FR-023**: Every externally visible simulated effect MUST have durable intent, a stable semantic
  idempotency key, an explicit lifecycle, and a ground-truth reconciliation procedure.
- **FR-024**: Duplicate delivery of a command or event MUST NOT create a second project entity,
  delegation, approval decision, artifact identity, audit identity, or external effect.
- **FR-025**: Authoritative project, channel, task, identity, delegation, execution, approval, effect,
  artifact, evidence, checkpoint, and audit state MUST survive a control-plane restart.
- **FR-026**: A lost runtime MUST be detected, fenced from new effects, checkpointed when possible,
  reconciled, and either safely resumed or placed in an actionable blocked or failed state.
- **FR-027**: A provider-neutral checkpoint MUST include the objective, acceptance criteria, current
  task state, decisions, open questions, repository revision and diff state, tool results, artifacts,
  evidence, remaining work, context manifest, budget and lease state, and effect reconciliation state.
- **FR-028**: A second conformant fake backend instance MUST be able to continue the same logical task
  and specialist from a valid checkpoint without changing authoritative identity or duplicating work.
- **FR-029**: Provider or harness session identifiers MAY be recorded as optional hints but MUST NOT
  be required to reconstruct project or task state.

#### Evidence and results

- **FR-030**: A specialist MUST be able to publish an attributable, integrity-addressed artifact bound
  to the project, task, execution, and controlled fixture Git revision.
- **FR-031**: Quality evaluation MUST use a logical reviewer outside the Engineering authoring lineage.
- **FR-032**: Verification MUST require the configured revision-bound build/test evidence, artifact
  integrity, requirement coverage, independent Quality approval, absence of blocking findings, and
  human approval where the evidence policy requires it.
- **FR-033**: Missing, failing, stale, mismatched-revision, or non-independent evidence MUST prevent
  `VERIFIED` and produce explicit remediation information. An evaluation whose captured policy,
  revision, evidence membership, or content hashes change before commit MUST become `STALE`, produce
  no Task transition, and require a fresh immutable snapshot and evaluation.
- **FR-034**: The Results surface MUST show task state, artifact and integrity, evidence rules and
  outcomes, approval history, backend execution, organization lineage, checkpoint/recovery events,
  current Project control state including paused/stopped/cancelled, and a chronologically ordered audit
  timeline.
- **FR-035**: The browser projection MUST recover missed events from durable state using stable event
  identities and MUST not display duplicates after reconnect or replay.
- **FR-036**: Every material state transition, backend choice, compiled context transfer, tool intent,
  approval, artifact, evidence decision, control command, and reconciliation outcome MUST be auditable
  with actor, target, time, reason, outcome, and correlation identity.

#### Scope and operational boundaries

- **FR-037**: The feature MUST provide a fresh local evaluation path that completes the full journey
  without real provider accounts, production deployment, or unrestricted repository execution.
- **FR-038**: The feature MUST exercise a real durable state model, policy decision path, approval
  path, idempotency boundary, checkpoint, recovery path, browser projection, and evidence decision;
  these behaviors MUST NOT be simulated solely in presentation.
- **FR-039**: The feature MUST NOT include multi-human functionality, Kubernetes, managed cloud,
  marketplace, desktop/mobile-native clients, semantic long-term memory, recursive specialist
  spawning, top-level autonomous project creation, local-GPU dependence, or autonomous
  self-improvement.
- **FR-040**: All limits and state policies used by the slice MUST be validated configuration within
  documented v0.1 ceilings rather than scattered fixed values. Runner eligibility MUST treat CPU,
  memory, process count, disk, maximum runtime, network mode, and optional GPU as explicit scheduler
  units and fail closed when required enforcement or cgroup/subordinate-ID/network/storage/filesystem
  discovery is absent; slice 001 remains eligible only for its fixture-process profile.
- **FR-041**: A context manifest MUST record which task inputs were supplied to fake execution, why,
  their provenance and hashes, their classifications, and the destination; raw channel history and
  private reasoning MUST not be used as implicit context.
- **FR-042**: The complete automated acceptance journey MUST be runnable against the controlled
  fixture and cover success, rejection, failure, stop, restart, runtime loss, duplicate delivery,
  backend switch, and evidence failure.

### Key Entities *(include if feature involves data)*

- **Supervisor**: The single human root authority for objectives, approvals, controls, policies, and
  inspection.
- **Project**: Durable objective, lifecycle (`CREATING`, `ACTIVE`, `PAUSING`, `PAUSED`, `RESUMING`,
  `STOPPING`, `STOPPED`, `CANCELLING`, `COMPLETED`, `BLOCKED`, `FAILED`, `CANCELLED`), policy profile,
  organization, resource status, and result boundary.
- **Channel**: Policy-bounded nested collaboration location with stable identity and archival state.
- **Task**: Durable unit of work with acceptance criteria, dependencies, assignee, evidence policy,
  and the states `PROPOSED`, `READY`, `QUEUED`, `RUNNING`, `WAITING_FOR_AGENT`,
  `WAITING_FOR_CAPACITY`, `WAITING_FOR_APPROVAL`, `BLOCKED`, `CLAIMED_COMPLETE`, `VERIFYING`,
  `VERIFIED`, `FAILED`, and `CANCELLED`.
- **PersonaIdentity**: Durable Product, Engineering, or Quality role, policy, memory references,
  permissions, history, and routing policy.
- **SpecialistIdentity**: Temporary delegated identity with bounded objective, lineage, grant, budget,
  and archival conditions.
- **AgentRuntime**: Ephemeral binding of one identity to one fake backend connection and model
  descriptor version, context, tool and budget leases, and optional session hint.
- **Delegation**: Immutable authority and work contract from one persona to one specialist.
- **ExecutionBackend / BackendConnection / ModelDescriptor / ConnectionModelDescriptor**: The minimum
  provider-neutral executable boundary, configured connection, backend-scoped versioned model
  resource, and per-connection availability/conformance relation; the slice supplies two
  interchangeable deterministic fake connections exposing the same descriptor snapshot without
  claiming general provider conformance.
- **Execution**: One runtime attempt with the states `QUEUED`, `STARTING`, `RUNNING`,
  `WAITING_FOR_APPROVAL`, `CHECKPOINTING`, `SUSPENDED`, `STOPPING`, `STOPPED`, `SUCCEEDED`, `FAILED`,
  `CANCELLED`, `LOST`, and `RECONCILING`.
- **Runner / RunnerLease**: Mutually authenticated fixture executor identity, discovered enforceable
  resource profile, and short-lived fenced authority for one bounded operation.
- **ToolCapability / ToolInvocation**: Leased authority and one attributable request evaluated by
  policy.
- **ApprovalRequest**: Action-bound decision with `REQUESTED`, `APPROVED`, `REJECTED`, `EXPIRED`, and
  `CANCELLED` states.
- **ExternalEffect**: Idempotent material fixture change with `REQUESTED`, `EXECUTING`, `APPLIED`,
  `FAILED`, `UNKNOWN`, `RECONCILING`, and `RECONCILED` states.
- **Artifact**: Integrity-addressed output with provenance and Git-revision binding.
- **Evidence / VerificationRule / VerificationEvaluation**: Attributable immutable observation,
  deterministic rule, and snapshot-bound evaluation whose complete non-stale passing set permits
  verification.
- **ExecutionCheckpoint**: Provider-neutral recovery snapshot with optional backend session hints.
- **AuditEvent**: Ordered immutable record of a material action or decision.
- **ContextManifest**: Provenance record for the minimized execution context.
- **UsageRecord / Budget**: Authoritative measured invocation, quota, and monetary usage where
  available; fake usage is deterministic and explicitly synthetic.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A supervisor can complete the fresh-install objective-to-results journey using only the
  documented local evaluation path and controlled fixtures, with all 16 required journey steps
  observable and no external provider credential.
- **SC-002**: Across automated crash tests at every scripted boundary before, during, and after the
  sensitive effect, 100% of recovered projects retain committed authoritative records and apply the
  semantic effect no more than once.
- **SC-003**: Across duplicate-delivery tests for every state-changing command, 100% return or converge
  on the original semantic result without creating duplicate effects or logical entities.
- **SC-004**: In 100% of passing evidence fixtures the task reaches `VERIFIED`; in 100% of missing,
  failing, stale, mismatched-revision, or same-lineage fixtures it does not.
- **SC-005**: A task checkpoint resumed on a second fake backend instance retains the same project,
  task, and specialist identities and completes with the same deterministic artifact and evidence
  outcome as an uninterrupted run.
- **SC-006**: At the default three concurrent cognitive executions, 95% of committed observable events
  appear in the connected browser within two seconds; at the ceiling of five, 95% appear within five
  seconds on the reference 16 GB remote-inference profile.
- **SC-007**: Pause, resume, approval, rejection, cancel, and stop commands acknowledge durable receipt
  to the supervisor within two seconds under the default reference workload.
- **SC-008**: After a control-plane restart, the project is inspectable within 60 seconds and its
  result projection contains no missing or duplicate durable events.
- **SC-009**: Automated authorization/security tests demonstrate zero successful specialist child
  creations, self-approvals, permission/budget escalations, same-lineage independent reviews,
  unauthenticated/replayed/revoked runner messages, or prohibited backend fields reaching persisted or
  public projections.
- **SC-010**: Every material action required by FR-036 has exactly one attributable audit identity and
  every verification outcome links to the expected controlled fixture Git revision.
- **SC-011**: The Results surface distinguishes verified, unverified, paused, stopped, blocked, failed,
  and cancelled outcomes without presenting any non-verified task as done in all acceptance fixtures.
- **SC-012**: The complete reference journey runs within the documented 16 GB PVE envelope with remote
  inference simulated, no local GPU, three default cognitive executions, and one standard runner job.

## Assumptions

- Iteration 0 plans one local supervisor identity and does not expose Moonshift on an untrusted
  network; the durable supervisor authentication mechanism is resolved before production-like use.
- The separate fixture runner is nevertheless authenticated in slice 001 with an owner-local
  per-instance mutually authenticated identity. Split/non-loopback runner enrollment UX remains later
  scope; the transport choice belongs to research and planning rather than this specification.
- The fixture repository is owned by the test suite, contains no secret or untrusted external
  dependency, and exposes a deterministic ground-truth effect that can be queried during recovery.
- Monetary usage generated by fake backends is labeled synthetic; no cost is inferred for subscription
  plans.
- Browser accessibility follows current web accessibility guidance; detailed interface conformance is
  planned with the UI implementation tasks rather than used to expand this slice.
- Retention and deletion periods remain human decisions; the slice preserves all fixture state for the
  duration of an acceptance run and restart test.
- The result may describe a fixture revision rather than create or push a remote branch or pull
  request. Remote Git mutation is outside this slice.
- The v0.1 resource targets are acceptance envelopes to validate, not guaranteed capacity claims for
  arbitrary repositories or real providers.
- Official provider terms are not exercised because the slice uses only deterministic fake backends.

## Exclusions

- Real model APIs, routing gateways, subscription-backed coding harnesses, and provider credentials.
- General backend-family capability probing, conformance, health, usage, routing, and compatibility;
  slice 001 defines only the deterministic fake minimum that slice 002 will generalize.
- Arbitrary shell, real package installation, real browser research, deployment, remote Git writes, or
  other uncontrolled effects.
- Production hardening or public release of the control plane, runner, or CLI.
- Team accounts, invitations, multi-human authorization, public collaboration, voice, or video.
- Semantic retrieval, autonomous memory promotion, recursive delegation, autonomous project creation,
  or self-modifying organization policy.
- Final license selection, public repository ownership, image namespace, and general retention policy.
