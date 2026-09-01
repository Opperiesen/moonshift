# Feature Specification: Execution Backend Contracts

**Feature Branch**: `codex/002-execution-backend-contracts`

**Created**: 2026-09-01

**Status**: Clarified and ready for planning

**Input**: Generalize the deterministic fake minimum from slice 001 into provider-neutral execution
backend-family contracts, discovery, capability probing, conformance, deterministic routing, usage,
health, checkpoint handling, and a compatibility corpus suitable for later real adapters.

## Clarifications

### Session 2026-09-01

- Repository authority resolves the implementation boundary to controlled deterministic adapters
  only; no real backend, credential, provider network, or compatibility claim belongs in this slice.
- Qualification must fail closed and precede portable execution; full corpus/reporting depth may then
  be delivered incrementally without allowing an unqualified route.
- Model API, coding harness, and local runtime profiles remain semantically distinct even when they
  share common envelopes, identifiers, provenance, and lifecycle vocabulary.
- Feature 001 behavior is a mandatory regression baseline, not a specification to be rewritten or a
  reason to preserve its current hard-coded fake coupling.
- No material ambiguity remains that requires a supervisor product decision before planning.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Qualify a Backend Before Use (Priority: P1)

As the supervisor, I can see which backend families, connections, and model descriptors Moonshift
knows about, together with their current capabilities, authentication posture, health, and conformance
status, so that an execution is never sent to an unqualified or incompatible connection.

**Why this priority**: Discovery and qualification are the fail-closed foundation for every later real
adapter. Without them, interchangeable execution would remain a hard-coded fake rather than a product
boundary.

**Independent Test**: Load a deterministic catalog containing multiple families, connections, models,
and probe outcomes; verify that Moonshift produces stable snapshots, exposes the reason each candidate
is eligible or ineligible, rejects malformed or stale claims, and never treats an unqualified
connection as executable.

**Acceptance Scenarios**:

1. **Given** a backend family with two configured deterministic connections, **When** discovery and
   qualification complete, **Then** the supervisor can inspect each family, connection, versioned model
   descriptor, authentication posture, declared and observed capabilities, health, and conformance
   status without exposing credentials or provider-private fields.
2. **Given** two connections that expose the same backend-scoped model descriptor, **When** their
   availability differs, **Then** Moonshift records two connection-model qualification relations
   without duplicating or changing the model descriptor identity.
3. **Given** an unknown schema version, expired probe, contradictory capability claim, failed mandatory
   conformance case, or unavailable authentication posture, **When** eligibility is evaluated, **Then**
   the connection fails closed with a stable reason and cannot receive an execution.
4. **Given** a family that does not implement an optional capability, **When** its applicable profile is
   evaluated, **Then** the capability is reported as unsupported rather than silently emulated or
   causing unrelated supported operations to fail qualification.

---

### User Story 2 - Execute Through One Portable Contract (Priority: P2)

As the supervisor, I can run a bounded task through any connection qualified for its backend-family
profile and receive the same Moonshift-owned request, ordered event, result, failure, usage, and
checkpoint semantics regardless of the adapter implementation.

**Why this priority**: Portable execution is the value unlocked by qualification, but it must build on
a trustworthy candidate set and preserve Moonshift-owned state and identity.

**Independent Test**: Run the same deterministic scenario through at least two independently
configured conformant fixture adapters and verify normalized-equivalent outcomes, ordered events,
stable identity/provenance, bounded cancellation, exact usage semantics, and strict rejection of
provider-private or malformed output.

**Acceptance Scenarios**:

1. **Given** two qualified connections for the required backend-family profile, **When** the same
   normalized request and starting state are executed, **Then** both produce contract-valid event and
   result streams whose observable meanings are equivalent and whose connection provenance remains
   distinct.
2. **Given** an execution request with required capabilities and budgets, **When** a connection accepts
   it, **Then** every event and terminal result is attributable to the execution, route decision,
   connection, adapter version, model descriptor version, and applicable conformance profile.
3. **Given** a cancellation or timeout, **When** execution terminates, **Then** Moonshift receives one
   normalized terminal outcome and records whether remote work is confirmed stopped, still unknown,
   or requires reconciliation.
4. **Given** malformed, oversized, out-of-order, duplicate, privately reasoned, credential-shaped, or
   provider-private output, **When** it crosses the adapter boundary, **Then** it is rejected or safely
   normalized without contaminating authoritative state, public projections, artifacts, or audit.
5. **Given** usage that is measured, estimated, unavailable, or synthetic, **When** the result is
   recorded, **Then** its source and confidence are explicit and unavailable monetary cost is never
   invented.

---

### User Story 3 - Route and Recover Deterministically (Priority: P3)

As the supervisor, I can rely on Moonshift to select an eligible backend connection for a task and to
resume on a compatible replacement after a recoverable loss, with an inspectable deterministic
decision rather than an opaque provider choice.

**Why this priority**: Routing and recovery depend on trustworthy qualification and portable execution
semantics. They make replaceability operational while preserving human control and fail-closed safety.

**Independent Test**: Evaluate a fixed candidate set containing healthy, degraded, incompatible,
nonconformant, and capacity-exhausted connections; verify stable eligibility and selection reasons,
then lose the selected connection and resume from a valid compatible checkpoint without changing the
logical task or agent identity or duplicating effects.

**Acceptance Scenarios**:

1. **Given** a task requirement, policy, budget, health snapshot, and fixed candidate set, **When**
   routing is evaluated repeatedly, **Then** the same eligible set, selected connection, and ordered
   reason codes are produced.
2. **Given** no connection satisfying every mandatory requirement, **When** routing is requested,
   **Then** Moonshift queues or blocks the execution with explicit unmet requirements and does not
   silently downgrade capabilities, conformance, privacy, or authentication posture.
3. **Given** a compatible provider-neutral checkpoint and a qualified replacement connection, **When**
   the original runtime is fenced and recovery is authorized, **Then** the same logical task and agent
   identity continue with a new execution attempt and no duplicate external effect.
4. **Given** a corrupt, stale, incompatible, or insufficiently classified checkpoint, **When** recovery
   is considered, **Then** Moonshift refuses automatic resume, preserves the evidence, and exposes an
   actionable block or supervisor decision.
5. **Given** health or conformance changes after route selection but before execution starts, **When**
   the start boundary revalidates authority, **Then** the stale decision is rejected and a new durable
   routing decision is required.

---

### User Story 4 - Prove Adapter Compatibility (Priority: P4)

As the Quality owner or adapter author, I can run a versioned deterministic conformance corpus against
an execution backend implementation and obtain a reproducible report showing exactly which required
and optional behaviors passed, failed, were not applicable, or remain unsupported.

**Why this priority**: The framework must make later adapter support claims objective and repeatable,
but its report and corpus can be delivered after the runtime boundary itself is demonstrably portable.

**Independent Test**: Run the complete corpus against the reference deterministic adapters, an
adapter missing an optional capability, and deliberately broken adapters; verify reproducible case
results, profile-aware status, compatibility-version handling, and that no failing mandatory profile
can be described as supported.

**Acceptance Scenarios**:

1. **Given** an adapter and a declared backend-family profile, **When** the versioned corpus runs,
   **Then** every applicable case records immutable inputs, expected observations, actual normalized
   observations, outcome, duration, provenance, and integrity references.
2. **Given** identical adapter and corpus versions with the same deterministic seed, **When** the suite
   is repeated, **Then** case outcomes and report identity are reproducible apart from explicitly
   excluded observational timing fields.
3. **Given** a mandatory case failure, unknown profile version, incomplete run, or tampered report,
   **When** support status is derived, **Then** the adapter or connection is not conformant for that
   profile.
4. **Given** a newer additive contract version, **When** an older reader processes a compatible
   envelope, **Then** required stable meaning is preserved; an incompatible major version is rejected
   before execution.
5. **Given** a conformance report, **When** the supervisor inspects a route or result, **Then** the exact
   report, profile, corpus, adapter, and contract versions governing the support claim are traceable.

### Edge Cases

- Discovery returns no models, duplicate descriptor identities with different immutable fields, or
  the same connection under two families.
- A connection reports healthy while authentication is unavailable, conformance is expired, or a
  required model relation is missing.
- A capability is declared at family level but unavailable for the selected model or connection.
- A probe completes after its lease, configuration revision, or adapter process has been replaced.
- An event sequence contains a gap, replay, conflicting duplicate, terminal event followed by output,
  or multiple terminal results.
- Cancellation is acknowledged while the underlying operation may still be running.
- A usage counter decreases, overflows, changes units, lacks provenance, or mixes synthetic and
  measured values.
- A checkpoint was created by a compatible family but requires a capability, artifact, context
  classification, or contract version unavailable on the replacement.
- Candidate health changes between eligibility calculation, route commitment, and execution start.
- All routes are degraded or budget-exhausted, or deterministic tie-break data is identical.
- The conformance process crashes, is cancelled, exceeds its budget, or produces a partially written
  report.
- An adapter attempts to pass through provider request, session, error, quota, reasoning, or credential
  fields outside the Moonshift-owned allowlist.

## Requirements *(mandatory)*

### Functional Requirements

#### Backend families, discovery, and qualification

- **FR-001**: Moonshift MUST represent model APIs, coding harnesses, and local runtimes as distinct
  execution backend families whose applicable capabilities and conformance profiles cannot be
  substituted for one another.
- **FR-002**: Moonshift MUST keep backend descriptor, adapter implementation and version, configured
  connection, backend-scoped versioned model descriptor, connection-model qualification, optional
  backend session hint, execution attempt, and logical agent identity as separate identities.
- **FR-003**: The system MUST expose a versioned provider-neutral discovery snapshot containing the
  family, connection, model descriptors, authentication posture, capability claims, health, probe
  provenance, and freshness boundary needed for eligibility decisions.
- **FR-004**: Model descriptors MUST be immutable backend-scoped versioned resources; connection-
  specific availability, capability observations, and conformance MUST reside in separate relations.
- **FR-005**: Declared capabilities MUST be reconciled with observed probe results and applicable
  conformance evidence; contradictory, unknown, expired, or malformed evidence MUST fail closed.
- **FR-006**: Capability support MUST distinguish required, optional, unsupported, temporarily
  unavailable, and not-applicable states without silently emulating a missing mandatory capability.
- **FR-007**: Health MUST distinguish readiness to accept new work from liveness and degraded operation,
  include freshness and provenance, and MUST NOT override failed authentication or conformance gates.
- **FR-008**: Authentication posture MUST be observable as a non-secret status and mode classification;
  credentials, consumer sessions, tokens, cookies, and provider-private authentication material MUST
  never appear in discovery, conformance, route, usage, event, result, or audit payloads.

#### Portable execution contracts

- **FR-009**: Moonshift MUST own versioned contracts for probe, discover, start, cancel, resume,
  normalized ordered events, terminal results, failures, usage, health, and checkpoints.
- **FR-010**: Every command, event, and result MUST carry stable message and correlation identity,
  execution attempt identity, connection and adapter provenance, contract version, and timestamps
  sufficient for deduplication, ordering, replay detection, and audit.
- **FR-011**: Start and resume requests MUST state the selected model descriptor version, required
  capabilities, minimized context manifest reference, authority and budget bounds, and idempotency
  identity; adapters MUST NOT infer broader authority from provider defaults.
- **FR-012**: Event streams MUST define monotonic per-execution sequence semantics, duplicate handling,
  bounded payloads, exactly one normalized terminal outcome, and a prohibition on events after terminal
  completion except reconciliation records in their separate lifecycle.
- **FR-013**: Failure normalization MUST distinguish at least invalid request, authentication,
  authorization, unsupported capability, unavailable model, quota or budget, capacity, timeout,
  cancellation, transport, malformed backend output, lost runtime, incompatible checkpoint, and
  unknown or reconciling effect outcomes.
- **FR-014**: Cancellation MUST be idempotent and MUST distinguish requested, acknowledged, confirmed
  stopped, already terminal, unknown, and reconciliation-required outcomes.
- **FR-015**: Usage MUST retain its unit, scope, source, confidence, synthetic/measured/estimated/
  unavailable status, and connection/model/execution provenance; Moonshift MUST NOT infer unavailable
  monetary cost or treat a subscription allowance as API spend.
- **FR-016**: Provider-specific requests, responses, errors, events, tools, sessions, usage, reasoning,
  and checkpoints MUST remain inside the adapter boundary and MUST be rejected from Moonshift-owned
  domain and public contracts.
- **FR-017**: Backend observations MUST pass kind-specific, bounded, provider-neutral validation and
  sanitization before they can affect authoritative state, projections, artifacts, evidence, or audit.

#### Routing, checkpoints, and recovery

- **FR-018**: Eligibility MUST evaluate family compatibility, required capabilities, model relation,
  authentication posture, conformance profile and freshness, health, policy, data classification,
  budget or quota status, capacity, and checkpoint compatibility where applicable.
- **FR-019**: Routing over a fixed input snapshot MUST be deterministic and MUST record all considered
  candidates, exclusion reasons, selected candidate, tie-break inputs, governing policy and contract
  versions, and the input snapshot identities.
- **FR-020**: Routing MUST fail closed when no candidate meets every mandatory requirement and MUST NOT
  silently downgrade family, capability, conformance, authentication, privacy, budget, or checkpoint
  constraints.
- **FR-021**: A committed route MUST be revalidated at the start boundary when its qualification,
  authority, configuration, health, capacity, or conformance evidence has become stale or superseded.
- **FR-022**: Provider-neutral checkpoints MUST preserve logical identity, task and objective state,
  accepted outputs, context and policy references, budgets, capabilities, event position, pending
  effects, artifacts, integrity data, and compatibility requirements while keeping backend sessions
  optional and non-authoritative.
- **FR-023**: Resume MUST create or identify a distinct execution attempt, fence lost authority, verify
  checkpoint integrity and compatibility, and preserve the logical task and agent identity without
  duplicating accepted output or external effects.
- **FR-024**: Automatic recovery MUST stop for corrupt, stale, incompatible, insufficiently classified,
  or unverifiable checkpoints and expose an actionable blocked state or supervisor decision.

#### Conformance and support evidence

- **FR-025**: Moonshift MUST define versioned conformance profiles whose mandatory and optional cases
  are specific to a backend family and claimed capabilities.
- **FR-026**: The deterministic compatibility corpus MUST cover discovery, capability truthfulness,
  authentication status, start, ordered streaming, results, failure normalization, cancellation,
  timeouts, checkpoint recovery, artifact and tool-intent normalization where claimed, usage, health,
  credential isolation, provenance, idempotency, and reconciliation.
- **FR-027**: Each conformance case MUST define immutable input, expected normalized observations,
  applicability, deterministic seed and clock, budgets, forbidden field classes, normalization version,
  and pass/fail criteria.
- **FR-028**: A conformance run MUST produce an integrity-addressed report linking family profile,
  corpus version, contract versions, adapter name and version, connection revision, model descriptor
  version, lease and fence, normalization/evaluator versions, case outcomes, incomplete cases,
  timestamps, freshness, and evidence references.
- **FR-029**: Support status MUST be derived from complete passing mandatory cases; failed, missing,
  expired, unknown-version, incomplete, or tampered evidence MUST NOT yield a conformant claim.
- **FR-030**: Contract evolution MUST state compatibility rules and reviewable version history;
  incompatible versions MUST be rejected before execution, additive compatible fields MUST NOT change
  established required meaning, and any case addition/removal/reclassification MUST invalidate report
  reuse unless an integrity-addressed compatibility manifest proves exact semantic compatibility.
- **FR-031**: The reference corpus MUST include at least two independently configured conformant
  deterministic adapters, optional-capability variants, and deliberately nonconformant variants for
  every fail-closed gate.
- **FR-032**: All accepted, rejected, malformed, stale, duplicate, cancelled, blocked, reconciled,
  qualification, conformance, route, recovery, and support-status-changing paths MUST produce
  attributable ordered audit records without private reasoning or secrets.

#### Scope boundaries

- **FR-033**: This feature MUST remain fully demonstrable with controlled deterministic fixtures;
  validation MUST run with provider credential variables absent, external network denied, no arbitrary
  shell capability added, and no deployment step, real provider account, consumer session, or
  production service required.
- **FR-034**: This feature MUST preserve Feature 001 behavior and migrate its deterministic fake
  minimum behind the generalized boundary without weakening its recovery, evidence, policy, runner,
  security, or supervisor-control guarantees.
- **FR-035**: This feature MUST NOT claim support for any real model API, routing gateway, coding
  harness, local model runtime, authentication mode, or provider compatibility.
- **FR-036**: The feature MUST expose only the minimum supervisor and quality observability required to
  inspect qualification, route, usage, health, and conformance evidence; a broader provider-management
  console remains later scope.

### Normative decision rules

The following rules are part of FR-001–FR-036 and remove implementation discretion at the trust,
qualification, conformance, and recovery boundaries.

#### Family profiles and fixture support scope

| Family semantic profile | Mandatory semantic responsibility | Never implied by the profile alone |
|---|---|---|
| `MODEL_API` | One bounded model invocation, normalized input/output events, model/usage provenance, cancellation, and declared modality/capability truth | Workspace mutation, harness sessions, local resource control, tools, or artifacts unless separately claimed and conformed |
| `CODING_HARNESS` | Minimized workspace/context manifest, tool intents, artifacts, checkpoints, cancellation, and effect/reconciliation observations | Model-endpoint identity, unrestricted shell/network, or authoritative harness session state |
| `LOCAL_RUNTIME` | Local model/runtime descriptor, resource/capacity and readiness observations, bounded start/cancel/result lifecycle, and local provenance | Shell authority, arbitrary filesystem/network access, or equivalence with a remote model API |
| `DETERMINISTIC_FIXTURE` | Direct deterministic Feature 001 regression behavior and fail-closed variants | Any production, provider, harness, authentication, or runtime support claim |

Common envelope cases govern identity, correlation, ordering, boundedness, failure, usage, authority,
audit, and credential isolation. Exact-family cases govern only the selected family profile.
Claimed-capability cases extend rather than replace both layers. In Feature 002 every adapter release is
`FIXTURE`, every profile/descriptor/report is `testOnly = true`, and every support scope is
`TEST_FIXTURE_ONLY`, including fixtures that simulate the first three family semantics.

#### Qualification and capability rules

Moonshift, never an adapter, assigns descriptor/snapshot identities and hashes and derives
qualification. Discovery and probe responses are untrusted observations. Qualification evaluates an
exact tuple of backend, adapter release, connection revision, model descriptor version, profile
version, probe/health lease and fence, conformance report, and freshness boundary in this precedence:

1. Reject malformed, oversized, integrity-invalid, unknown-version, wrong-profile, wrong-release,
   wrong-revision, expired, or stale-fence evidence. Preserve attributable stale evidence without
   refreshing current state.
2. Require the fixture authentication mode and `AVAILABLE` posture; other postures are ineligible.
3. Require the exact immutable model relation and family profile; zero models is a valid empty
   discovery but yields no qualification, duplicate identity with different immutable fields is
   malformed, and one connection appearing under multiple families is rejected. A discovery marked
   incomplete or terminated by timeout is preserved as partial evidence but cannot create or refresh a
   catalog snapshot used for qualification; a probe timeout likewise yields a stable ineligible reason
   and never reuses the prior probe as current.
4. Require fresh `LIVE` and `READY` health. `DEGRADED`, `NOT_READY`, `UNREACHABLE`, and `UNKNOWN` remain
   visible but are ineligible for new work in this slice.
5. Require a complete, current, integrity-valid, passing minimum profile report and every mandatory
   capability. A contradictory capability source is ineligible rather than resolved by precedence.

Capability `requirement` is exactly `MANDATORY` or `OPTIONAL`; its scoped observation `status` is
exactly one of `SUPPORTED`, `UNSUPPORTED`, `TEMPORARILY_UNAVAILABLE`, `NOT_APPLICABLE`, or `UNKNOWN`.
An unclaimed optional capability is `NOT_APPLICABLE`; a claimed capability whose applicable case fails
is `UNSUPPORTED`; temporary loss is not support; `UNKNOWN` always excludes the capability. Every
ineligible tuple retains stable, sorted reason codes for all safely evaluable failing gates.

#### Execution, failure, usage, and observability rules

Before schema validation, protocol, catalog, route, report, and profile messages are limited to
1,048,576 UTF-8 bytes and JSON depth 16; corpus manifests to 4,194,304 bytes and depth 16; and
individual event or conformance-case payloads to 65,536 bytes and depth 16. Schema-specific count,
decimal, timestamp, identifier, and sequence bounds apply in addition. A framing violation is rejected
without accepting a partial observation.

Event meaning is kind-specific; contract `2.0` has no generic extension or observable object. A byte-
identical replay with the same message ID, execution, sequence, and normalized hash is idempotently
ignored and audited. A conflicting duplicate, gap, overflow, multiple backend result, or post-result
event is `MALFORMED_OUTPUT`, cannot update projections, and requires reconciliation when effect status
is not known. A `COMPLETED` or `FAILED` event is only an observation; exactly one accepted
`backend.result` closes the backend attempt. Cancellation racing with a terminal result accepts the
first valid terminal result, records later acknowledgement as reconciliation evidence, and never
creates a second terminal outcome.

Failure disposition is derived from the versioned `(category, reasonCode, effectStatus)` mapping, not
adapter advice. Invalid request is never retried; authentication/authorization and budget failures
require review; unsupported capability, unavailable model, quota, or capacity may reroute only to a
fully qualified candidate; timeout or transport may retry/reroute only when the effect is proven not
applied; unknown or reconciling effects always require reconciliation before any successor authority.

Usage quantities are non-negative bounded decimal strings with at most 38 integer and 9 fractional
digits. Dimension, unit, scope, source, measurement kind, confidence, interval, connection, model, and
execution provenance form the comparison key. A decreasing counter, overflow, unit change, missing or
unknown provenance, or conflicting duplicate is rejected; different units and mixed synthetic,
estimated, measured, or unavailable records remain separate and are never silently converted or
summed. Monetary cost exists only as separately evidenced currency/amount data.

For SC-002, equivalent observable meaning compares ordered event kind and event-specific normalized
payload hash, terminal outcome/effect/cancellation status, artifact/checkpoint content hashes, and exact
usage dimensions/quantities/units/measurement kinds. Message, adapter, connection, model, report,
timestamps, and evidence identifiers are excluded from equality but MUST remain present and distinct
as provenance.

#### Conformance, reports, and compatibility

Each conformance case resets to the corpus clock epoch, derives its seed from the corpus seed and
immutable case ID/version, and explicitly bounds runtime, events, artifacts, usage records, payload
bytes, and payload depth. Ambient time, randomness, or process limits are never inherited.

Common cases are always applicable and mandatory. Family cases apply only to the exact family profile.
Capability cases are `NOT_APPLICABLE` when the capability is not claimed; when claimed, every mapped
case is mandatory for support of that exact capability set. A complete run contains one terminal result
for every applicable case and no cancelled, skipped, unknown-version, or incomplete case. A cancelled,
timed-out, crashed, or partially committed run preserves immutable partial evidence but derives no
support.

Normalized case identity excludes only start/end/duration observations under an exact normalization
version; evidence hashes include them. Report totals, applicability, outcomes, mandatory completeness,
and status must reconcile. Tampering with the profile/corpus manifest, input, expected/actual evidence,
artifact, summary, or report hash; a stale lease/fence; a superseded adapter or configuration; or
expired evidence yields a distinct fail-closed reason. Support is separately derived for the exact
adapter release, connection revision, model relation, family profile, and claimed capability set. The
adapter author cannot write a report or support claim into authoritative state; independent Quality
review owns profile/corpus changes and support evidence.

An additive version is compatible only when the reader declares its exact minor range, absent optional
fields have an explicit meaning-preserving default, required meaning and normalization are unchanged,
and bidirectional compatibility fixtures pass. Adding, removing, or reclassifying a mandatory case or
changing applicability, identity, hash, authority, privacy, effect, or failure semantics requires a new
profile/corpus version and fresh report; an integrity-addressed compatibility manifest must explicitly
authorize any prior report reuse. Model changes create a new immutable descriptor version.

#### Routing, checkpoints, recovery, and audit

A route normalizes and hashes the requirement, evaluator version, policy, and candidate evidence;
observational timestamps are included only through referenced snapshot identities. No candidates,
all-degraded candidates, exhausted budget, or identical tie-break inputs yield `BLOCKED` or `QUEUED`
with stable reasons and no selection. Exact final identity bytes break otherwise equal candidates.
Auth, conformance, health, capacity, budget, policy, classification, capability, model, or checkpoint
change before start invalidates the committed route and requires an immutable successor decision.

A valid automatic-resume fixture has intact hashes/artifacts, supported contract/profile/model and
capabilities, sufficient classification and allowed destination, compatible context and remaining
budgets/usage units, a consistent accepted event position, reconciled effects, and fenced prior
authority. Corrupt hashes, missing artifacts, stale versions, incompatible family/profile/model or
usage units, insufficient classification/destination, event gaps, pending unknown effects, or an
unverifiable checkpoint block resume. Loss of an optional session hint alone does not block a
provider-neutral resume; the hint never grants authority.

Adapter messages, profile/case inputs, reports, routes, checkpoints, usage, and all observations remain
untrusted until Moonshift validation and derivation. Accepted, rejected, malformed, stale, duplicate,
cancelled, blocked, reconciled, and support-changing paths are audited. Credentials, tokens, cookies,
consumer sessions, raw errors, provider-private fields, prompt-injection-shaped content, private
reasoning, raw transcripts, arbitrary paths, and unclassified extensions are forbidden from domain,
persistence, projections, artifacts, evidence, audit, public API, and logs.

#### Required deterministic populations

Acceptance fixtures MUST include: current conformant; optional capability unclaimed; claimed
capability failed; contradictory claim; zero/duplicate/cross-family model discovery; partial discovery;
probe timeout; stale lease/fence/revision/release; unusable auth; every liveness/readiness state;
missing/failed/expired/unknown/tampered/incomplete conformance; no/all-degraded/budget/capacity/policy-
changed route sets; every event duplicate/gap/overflow/post-terminal race; every prohibited-field
class; decreasing/overflow/unit-change/mixed-kind usage; and valid, corrupt, stale, incompatible,
insufficient, missing-artifact, pending-effect, and missing-optional-session-hint checkpoints. Each
population has an explicit expected qualification, route, support, terminal/reconciliation, leakage,
and resume/block outcome. The corpus crash matrix covers before case start, during observation, after
evidence write, and before report/support commit.

### Key Entities *(include if feature involves data)*

- **BackendFamilyProfile**: Versioned Moonshift definition of one execution family, its contract,
  capabilities, mandatory and optional conformance cases, and compatibility rules.
- **BackendDescriptor**: Stable identity and classification of a backend implementation boundary,
  independent of any configured connection.
- **AdapterRelease**: Named adapter implementation and version with supported contract/profile ranges;
  never an agent identity or authoritative project state.
- **BackendConnection**: Owner-configured instance of an adapter with non-secret authentication posture,
  configuration revision, lifecycle, and connection-specific health.
- **ModelDescriptor**: Immutable backend-scoped, versioned model or runtime resource independent of
  connection availability.
- **ConnectionModelQualification**: Time-bounded relation recording whether one model descriptor is
  available and conformant on one connection, with observed capabilities and evidence provenance.
- **CapabilitySet**: Versioned required, optional, unsupported, unavailable, and not-applicable
  capability claims with source and scope.
- **ProbeSnapshot / HealthSnapshot**: Immutable time-bounded observations used for qualification and
  routing, including freshness, provenance, and configuration revision.
- **ExecutionRequirement**: Provider-neutral family, capability, classification, budget, policy,
  model, and checkpoint constraints for one execution attempt.
- **RouteDecision**: Immutable deterministic evaluation of candidates, exclusions, selection,
  tie-break inputs, and governing snapshot and policy versions.
- **BackendCommand / BackendEvent / BackendResult / BackendFailure**: Versioned normalized execution
  messages that remain independent of provider and harness types.
- **UsageRecord**: Attributable measured, estimated, synthetic, or unavailable consumption with units,
  source, confidence, and execution provenance.
- **ExecutionCheckpoint**: Integrity-addressed provider-neutral continuation state plus explicit
  compatibility requirements and optional non-authoritative backend session hints.
- **ConformanceProfile / ConformanceCase / ConformanceRun / ConformanceReport**: Versioned support
  definition, deterministic scenario, bounded execution, and integrity-addressed case evidence from
  which qualification is derived.
- **SupportClaim**: Derived, expiring statement that an adapter or connection conforms to a profile and
  capability set, always traceable to a complete report.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 100% of qualification fixtures, only connections with current passing mandatory
  conformance, usable authentication posture, fresh health, and every required capability are eligible;
  every ineligible connection exposes at least one stable exclusion reason.
- **SC-002**: The same normalized scenario executed through both conformant reference adapters produces
  equivalent ordered observable meaning and terminal outcome while preserving distinct adapter,
  connection, and model provenance in 100% of corpus runs.
- **SC-003**: Across malformed, oversized, out-of-order, conflicting-duplicate, post-terminal,
  credential-shaped, private-reasoning-shaped, and provider-private fixtures, zero prohibited fields or
  invalid observations reach domain state, persistence, projections, artifacts, evidence, audit,
  public API, or logs.
- **SC-004**: Repeated routing over an identical input snapshot produces byte-equivalent eligible sets,
  selection, and reason codes under the same evaluator version in 100% of deterministic tests;
  wall-clock observations participate only through frozen snapshot identities.
- **SC-005**: Across all required capability, health, authentication, conformance, budget, privacy,
  capacity, and checkpoint failure fixtures, routing performs zero silent downgrade selections.
- **SC-006**: In 100% of valid replacement fixtures, resume preserves project, task, and agent identity,
  records a distinct execution attempt, and duplicates neither accepted output nor external effects;
  100% of corrupt or incompatible checkpoints are blocked.
- **SC-007**: Every mandatory conformance failure, incomplete run, expired report, unknown version, and
  integrity mismatch prevents a conformant support claim with a distinct stable evidence/reason state
  in 100% of derivation tests.
- **SC-008**: Repeating the corpus with the same adapter, versions, seed, clock, and starting state
  produces the same case outcomes and integrity-bearing normalized evidence in 100% of reference runs,
  excluding fields explicitly declared observational.
- **SC-009**: Every execution, route, result, checkpoint, usage record, and support claim can be traced
  to the exact contract, profile, adapter, connection, model descriptor, configuration, and evidence
  versions that governed it.
- **SC-010**: The full Feature 001 deterministic journey passes unchanged through the generalized
  boundary, and the complete Feature 002 fixture evaluation requires zero external credentials or
  network services, adds no arbitrary shell capability, and performs no deployment.
- **SC-011**: On the documented reference development host, deterministic routing over 100 candidates
  completes within 100 milliseconds and the bounded 500-case conformance corpus completes within 60
  seconds with the manifest clock/seed, one corpus worker, warm local processes, and no external
  network, without exceeding the existing Feature 001 resource envelope.

## Assumptions

- Feature 001 is the accepted `1.0` contract baseline at integrated revision `e9e3c05`; its normative
  schemas in `specs/001-supervised-autonomous-loop/contracts/`, migration manifest, deterministic fake
  scenarios, runner boundary, persistence, projections, recovery, and evidence semantics remain
  available for regression tests. New execution attempts write Feature 002 `2.0`; legacy rows are
  mapped read-only and are never rewritten to manufacture new evidence.
- All adapters in this feature are owner-controlled deterministic fixtures; their authentication
  posture is `NONE_FIXTURE` and does not exercise vendor terms or credential storage.
- Capability taxonomies and conformance profiles are Moonshift-owned alpha contracts and may evolve
  through explicit compatibility rules before stabilization.
- Health, discovery, and conformance evidence use bounded freshness configured by policy; this feature
  defines deterministic policy behavior rather than production polling schedules.
- Monetary usage may be unavailable or synthetic. Budget enforcement uses explicit normalized units
  and never assumes vendor billing equivalence.
- A supervisor remains the single root authority; backend qualification and routing never grant an
  adapter authority beyond an existing execution, capability, policy, and budget envelope.
- Open decisions OD-005 through OD-010 remain untouched: no runner runtime, retention, default real
  authentication, release namespace, subscription harness terms, or API-provider compatibility choice
  can be inferred from fixture configuration, documentation, or conformance results. OD-007, OD-009,
  and OD-010 remain explicit gates before any real backend is enabled or described as supported.

## Exclusions

- Real OpenAI-compatible, OpenRouter, OpenAI, Anthropic, Google, local-model, Codex, Claude Code,
  Gemini CLI, Antigravity, or other provider and harness adapters.
- Real provider credentials, subscription or consumer sessions, vendor OAuth, workspace enrollment,
  secret storage UX, or terms and compatibility support claims.
- Cross-provider cost optimization, quality learning, semantic routing, autonomous model selection,
  benchmark-based promotion, or self-modifying routing policy.
- Arbitrary repository execution, unrestricted shell, production network egress, hostile repository
  isolation, rootless OCI execution, or general runner tooling.
- Production deployment, remote Git effects, public release, license choice, retention policy, or
  reference PVE capacity certification.
- A full provider-administration dashboard, multi-human access control, marketplace, managed service,
  or public adapter registry.
- Changes to the default organization, recursive delegation, memory system, evidence promotion rules,
  or supervisor authority beyond what is strictly required to carry backend provenance.
