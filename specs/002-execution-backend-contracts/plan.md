# Implementation Plan: Execution Backend Contracts

**Branch**: `codex/002-execution-backend-contracts` | **Date**: 2026-09-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-execution-backend-contracts/spec.md`

## Summary

Replace Feature 001's scheduler-to-fake coupling with Moonshift-owned, versioned execution-backend
family contracts and a durable qualification boundary. The slice introduces common envelopes plus
family profiles, immutable discovery and health evidence, deterministic capability/conformance
eligibility, normalized execution/result/failure/usage/checkpoint semantics, auditable routing, and a
reproducible conformance corpus. Existing deterministic fake behavior migrates through the boundary
and remains the only executable implementation; no provider credential, network adapter, consumer
session, arbitrary shell, or real support claim is added.

## Technical Context

**Language/Version**: Node.js 24 LTS with pinned TypeScript 7.0.2

**Primary Dependencies**: Existing workspace dependencies only: Ajv 8.20.0 for Draft 2020-12 runtime
validation, `@sourcemeta/jsonschema` 16.8.0 for generated types, Fastify 5.12.1 for the existing local
control-plane API, and `pg` 8.23.0 for durable repositories. No new runtime dependency is planned.

**Storage**: PostgreSQL 18 authoritative catalog, qualification, conformance, routing, usage, and
audit records; owner-local content-addressed artifact storage for detailed conformance evidence.

**Testing**: Vitest 4.1.11 contract/unit/integration/recovery/security projects with deterministic
clocks, seeds, and deliberately nonconformant adapters; Playwright 1.62.1 only for the minimum existing
supervisor visibility needed to inspect qualification and route evidence.

**Target Platform**: Self-hosted Linux control plane and fixture runner, developed and validated on
the existing Node.js-supported host; no real provider network is required. The 16 GB Proxmox VE
direction remains a compatibility constraint, not a new capacity certification.

**Project Type**: Existing pnpm monorepo with browser, control-plane, runner, and CLI applications plus
domain, contracts, persistence, policy, verification, and deterministic backend packages.

**Performance Goals**: Evaluate a fixed routing snapshot deterministically in under 100 ms for 100
candidates on the development host recorded in the baseline evidence; validate a 500-case deterministic
conformance corpus in under 60 seconds on that same host with one corpus worker, the manifest seed and
clock, warm local processes, and no external network; preserve Feature 001 event and control latency
envelopes. These are slice-validation envelopes, not production capacity or support claims.

**Constraints**: One supervisor; provider-neutral types; no real credentials, provider network,
consumer sessions, or unrestricted code execution; strict bounded payloads and sanitizer allowlists;
all support claims evidence-derived; no silent capability, privacy, conformance, or budget downgrade;
Feature 001 remains regression-clean.

**Scale/Scope**: Three semantic backend-family profile kinds plus a test-only deterministic fixture
profile; two conformant fixture connections, optional-capability variants, and fail-closed broken
variants; one active project baseline, up to 100 catalog candidates per deterministic routing test,
and a corpus ceiling of 500 cases for the slice.

## Constitution Check

### Pre-design gate

| Principle / constraint | Result | Plan evidence |
|---|---|---|
| Human sovereignty | PASS | Qualification, route blocks, recovery decisions, and support evidence remain inspectable; no adapter can self-authorize or override stop/cancel policy. |
| Identity independent from execution | PASS | Agent, runtime, execution, family, adapter, connection, descriptor, route, conformance, and optional session identities remain separate. |
| Moonshift-owned authoritative state | PASS | PostgreSQL and content-addressed evidence own catalog snapshots, decisions, checkpoints, and reports; backend sessions are hints only. |
| Backend family separation | PASS | Common envelopes do not erase distinct model-API, coding-harness, and local-runtime profiles; deterministic fixtures are labeled test-only. |
| Replaceability and conformance | PASS | Eligibility requires fresh profile-aware conformance evidence; deliberately broken adapters prove fail-closed derivation. |
| Provider-neutral domain contracts | PASS | Schemas and domain values use Moonshift vocabulary; provider-specific values are rejected at the adapter boundary. |
| Evidence-based completion | PASS | Feature completion and adapter support are both derived from deterministic evidence, never adapter prose. |
| Bounded autonomy and capacity | PASS | Requests carry existing authority/budget limits; routing cannot broaden them and corpus execution is bounded. |
| Independent quality | PASS | Conformance report quality and the implementation itself require independent review outside the authoring lineage. |
| Plane separation and least privilege | PASS | The control plane orchestrates deterministic adapters; existing fixture runner capabilities remain unchanged and no shell/network capability is introduced. |
| Audit and durable effects | PASS | Probe, qualification, route, start, cancel, result, checkpoint, and recovery decisions are durable, correlated, idempotent, and reconcilable. |
| Context minimization and data sovereignty | PASS | Requests reference existing minimized context manifests and record destination/classification without forwarding raw chat or secrets. |
| Official auth and terms | PASS | No real adapter/authentication is exercised; OD-007, OD-009, and OD-010 remain open and untouched. |
| Incremental vertical delivery | PASS | Four independently testable stories progress from qualification to portable execution, deterministic routing/recovery, and objective compatibility evidence. |
| Reproducible/reversible change | PASS | Forward-only migration, compatibility rules, deterministic fixtures, backup/restore coverage, and rollback-by-application-version are planned. |

**Pre-design result**: PASS. No constitutional exception or unresolved product decision is required.

## Architecture

### Dependency direction

```text
Feature 002 JSON Schemas
          │
          ▼
@moonshift/contracts ── validation / generated provider-neutral wire types
          │
          ├──────────────► @moonshift/backend-conformance
          │                         │
          ▼                         ▼
@moonshift/domain ◄────── @moonshift/backend-fake
          │                         │
          ▼                         │
control-plane application / router │
          │                         │
          ▼                         │
persistence repositories ◄─────────┘
```

Domain packages do not import Fastify, PostgreSQL, the fixture implementation, or provider SDK
types. `@moonshift/contracts` owns wire validation and safe projection shapes.
`@moonshift/backend-conformance` owns deterministic corpus execution and report derivation while
depending only on Moonshift contracts and bounded adapter ports. The control plane owns policy-aware
catalog qualification, durable route decisions, scheduling, and recovery. `@moonshift/backend-fake`
implements the port and supplies controlled variants; the scheduler no longer imports its constants
or factory directly. Backend supervision queries are additive `/v1` routes on the existing loopback
Fastify server at port `4310` and use the existing `LocalSupervisorSession`; no second server or weaker
authentication boundary is introduced.

### Contract and profile layers

1. **Common envelope** defines identifiers, correlation, causation, contract version, provenance,
   bounded timestamps, idempotency, execution lifecycle, failure, usage, and checkpoint references.
2. **Family profile** defines semantic requirements that cannot be flattened across `MODEL_API`,
   `CODING_HARNESS`, and `LOCAL_RUNTIME`.
3. **Capability profile** adds mandatory cases only when a connection claims streaming, structured
   output, tools, artifacts, cancellation, resume, or another optional behavior.
4. **Adapter port** translates only inside its boundary and returns provider-neutral messages.
5. **Qualification** derives executable support from current probe, health, authentication,
   connection-model relation, and conformance evidence.

The test-only `DETERMINISTIC_FIXTURE` profile preserves Feature 001 without being eligible for a real
backend support claim. Family-specific deterministic simulators exercise the three semantic profiles
without contacting external systems. Every adapter release in this slice has `implementationKind =
FIXTURE`, every profile and descriptor has `testOnly = true` and `supportScope = TEST_FIXTURE_ONLY`, and
those invariants hold even when a fixture simulates `MODEL_API`, `CODING_HARNESS`, or `LOCAL_RUNTIME`
semantics.

The Foundation checkpoint implements the minimum versioned profile and mandatory qualification corpus
needed to derive US1 eligibility. US4 extends that same manifest with the complete common, family, and
claimed-capability corpus; it does not retroactively invent the evidence required by US1.

### Qualification and routing path

```text
adapter registration/config revision
  → bounded probe + discovery
  → sanitize and persist immutable snapshots
  → run/apply profile-aware conformance evidence
  → derive connection-model qualification
  → build immutable routing input snapshot
  → evaluate exclusions and stable tie-break
  → commit auditable route decision
  → revalidate snapshot/authority at start
  → call adapter port or fail closed
```

Routing consumes a frozen snapshot and a versioned policy. It never reads mutable adapter state while
sorting candidates. Candidate exclusion reasons are stable codes; identical inputs yield identical
ordered candidates, selection, and decision hash. Live health or configuration changes invalidate a
committed decision and require a successor decision rather than mutating history.

### Execution and recovery path

The generalized adapter port supports bounded `probe`, `discover`, `start`, `cancel`, and `resume`
operations. Every event is validated, sanitized, deduplicated, and sequenced before projection.
Exactly one normalized terminal result closes an attempt. Cancellation distinguishes local request,
adapter acknowledgement, confirmed termination, already-terminal, unknown effect, and reconciliation.

Recovery continues to use Moonshift-owned checkpoints. Feature 002 adds an explicit compatibility
requirement set and profile/contract evidence to the checkpoint. A replacement creates a successor
execution only after the old authority is fenced, effects reconcile, the checkpoint validates, the
candidate qualifies, and context is recompiled. Optional provider or harness session hints never
become a prerequisite.

## Data, Persistence, and Migration Design

The complete entity and invariant model is in [data-model.md](data-model.md). A forward-only
`004_execution_backends.sql` migration introduces normalized authoritative tables for backend
descriptors, adapter releases, connections, immutable model descriptors, probe/health snapshots,
connection-model qualifications, conformance reports, route decisions, and usage records. Large case
evidence stays integrity-addressed in the artifact store; PostgreSQL retains report summaries, hashes,
and references.

Existing Feature 001 fake constants are imported once by a data/bootstrap adapter and converted to
the new test-only profile. Existing execution/project records remain readable. The migration does not
rewrite old audit events or checkpoints; readers map their `1.0` fake-minimum provenance into a
documented legacy view. New execution attempts use Feature 002 `2.0` contracts. Backup/restore tests
must restore catalog, probe/health, qualification, report summaries, report artifacts/hashes, routes,
usage, and legacy records as one consistent set; missing or mismatched evidence makes qualification
and support `UNKNOWN` and ineligible rather than reconstructing a partial claim.

Rollback means running the prior application against a pre-migration backup or leaving the additive
tables unused; the forward migration itself is not reversed destructively. No provider secret column
is introduced. Connections retain only opaque future credential references and non-secret auth
posture, with fixture values in this slice.

## Security and Privacy Design

- Adapter input/output validators use exact kind-specific allowlists, pre-schema byte/depth framing,
  schema count/value bounds, and stable normalized failure codes. Messages are bounded to 1 MiB,
  corpus manifests to 4 MiB, nesting to depth 16, and individual event/case payloads to 64 KiB.
- Unknown capability, family, contract, profile, configuration, or report versions fail closed.
- Credentials, tokens, cookies, consumer sessions, raw provider errors, arbitrary paths, private
  reasoning, raw transcripts, prompt-injection-shaped fields, and unclassified extensions are rejected
  from domain, persistence, projections, artifacts, evidence, audit, public API, and logs. Contract
  `2.0` has no generic extension map; a later extension requires a Moonshift-owned named schema and
  compatibility evidence before it can be accepted.
- Probe and conformance leases bind adapter, connection, configuration revision, profile, budget,
  clock, and fencing identity so late results cannot refresh current qualification.
- Conformance reports are integrity-addressed and cannot directly self-promote an adapter; support is
  derived by a separate deterministic evaluator from complete applicable cases.
- Each case deterministically resets to the corpus epoch, derives its seed from corpus seed plus case
  identity/version, and carries explicit runtime/event/artifact/usage/byte/depth budgets.
- Route revalidation prevents time-of-check/time-of-use selection after auth, health, configuration,
  conformance, policy, budget, capacity, or checkpoint evidence changes.
- Existing context manifests continue to constrain classification and destination. No new external
  destination is permitted in this fixture-only slice.

## Test Strategy and Evidence

| Layer | Required evidence |
|---|---|
| Schema and generation | Draft 2020-12 validity, generated-type reproducibility, accepted examples, unknown-version/field and boundary rejection |
| Domain | Identity separation, immutable descriptor versions, capability truth table, freshness, qualification, compatibility, support derivation, route determinism |
| Adapter contract | Common/family/capability corpus across two conformant fixtures, optional variants, and deliberate failures |
| Persistence | Migration, immutable snapshots, idempotent writes, stale-result fencing, exact report/hash and route provenance, backup/restore |
| Control-plane integration | Catalog refresh, qualification, scheduling without fake imports, start revalidation, cancel outcome, checkpoint switch, blocked recovery |
| Security | Exact byte/depth/payload framing; secret/provider/private-reasoning rejection; contradictory claims; tampered reports/checkpoints; downgrade prevention; launched fixture with credentials scrubbed and network/shell/deployment barriers active |
| Acceptance | Supervisor inspects catalog/route/conformance evidence; Feature 001 journey passes unchanged through generalized boundary |
| Recovery | Crash before/during/after probe, qualification, case observation, evidence write, report/support commit, route commit, start, cancel, result, usage, checkpoint, and resume; each boundary proves idempotency, fencing, and fail-closed partial state |

Contract-first tests are written and observed failing before implementation. Story checkpoints bind
evidence to the exact Git revision and corpus/profile/contract versions. Final validation runs the
repository-native suite, acceptance, clean generated-contract check, backup/restore, security,
convergence, and independent review.

## Project Structure

### Documentation (this feature)

```text
specs/002-execution-backend-contracts/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── checklists/
│   ├── requirements.md
│   ├── backend-contracts.md
│   ├── conformance.md
│   └── security-and-recovery.md
└── contracts/
    ├── README.md
    ├── backend-catalog.schema.json
    ├── backend-supervision.openapi.yaml
    ├── conformance-corpus.schema.json
    ├── conformance-profile.schema.json
    ├── conformance-report.schema.json
    ├── execution-protocol.schema.json
    └── routing-decision.schema.json
```

### Source Code (repository root)

```text
packages/
├── contracts/src/                 # generated types, validators, safe sanitizers
├── domain/src/                    # catalog, qualification, routing/checkpoint value rules
├── backend-conformance/src/       # bounded corpus runner and support derivation
├── backend-fake/src/              # generalized port plus deterministic variants
└── persistence/src/
    ├── migrations/004_execution_backends.sql
    └── repositories/execution-backends.ts

apps/control-plane/src/
├── application/backends/          # catalog, probe, conformance and usage services
├── scheduler/                     # adapter registry, deterministic router, start/recovery integration
└── projections/                   # minimum supervisor qualification/route evidence views

tests/
├── contract/                      # schemas, adapters, profiles and corpus
├── unit/                          # pure qualification/routing/support rules
├── integration/                   # persistence and control-plane paths
├── recovery/                      # stale results, cancellation and checkpoint switch
├── security/                      # injection, secret/provider-field and downgrade rejection
└── acceptance/                    # catalog/route evidence plus Feature 001 regression
```

**Structure Decision**: Extend the existing monorepo and application boundaries. Add only one package,
`@moonshift/backend-conformance`, because the corpus must test adapters without importing the control
plane and later real adapters must reuse the same gate. Contracts remain in the existing contracts
package; policy-aware routing remains in the control plane; the deterministic implementation remains
in `backend-fake`.

## Implementation Phases

1. **Setup and contract baseline**: Point generation/validation at versioned Feature 002 contracts,
   add package/test scaffolding, and capture Feature 001 regression evidence.
2. **Foundational backend registry**: Domain catalog/qualification values, adapter port, persistence
   migration/repositories, sanitizers, audit/provenance, and deterministic clocks/IDs.
3. **US1 — Qualify a backend before use**: Discovery, probe, health/auth/capability evidence,
   conformance minimum, durable qualification, and supervisor inspection.
4. **US2 — Execute through one portable contract**: Start/event/result/failure/usage/cancel/resume
   semantics, migrate both Feature 001 fixture connections, and remove scheduler fake coupling.
5. **US3 — Route and recover deterministically**: Immutable routing snapshots, exclusion reasons,
   stable selection, start revalidation, checkpoint compatibility, fencing, and successor execution.
6. **US4 — Prove adapter compatibility**: Full common/family/capability corpus, deterministic variants,
   integrity reports, support derivation, version compatibility, and traceable inspection.
7. **Cross-cutting proof**: Crash/security/backup/restore/performance matrices, full Feature 001
   regression, quickstart, independent review, evidence, and convergence.

The next bounded implementation session should begin with setup/foundation plus the smallest complete
US1 qualification path; it must stop at the US1 checkpoint before US2 execution portability begins.

## Post-design Constitution Check

All pre-design gates remain `PASS` after the research, data model, contracts, migration strategy,
security boundaries, and story phases:

- Common envelopes preserve rather than erase backend-family semantics.
- Every support and route decision is derived from durable, current, profile-aware evidence.
- Provider-private types, credentials, sessions, and reasoning remain confined or rejected.
- Checkpoints, logical identity, effects, context, artifacts, and audit remain Moonshift-authoritative.
- No adapter gains policy, tool, network, budget, or supervisor authority from this abstraction.
- Real-provider decisions and terms gates remain open and outside the implementation task range.
- Feature 001 behavior, recovery, security, evidence, and resource constraints remain mandatory
  regression gates.
- The forward migration, compatibility readers, backup/restore, deterministic corpus, and independent
  review make the change reproducible and reversible at the application/checkpoint level.

**Post-design result**: PASS — the feature is ready for requirements-quality checklists and task
decomposition. No constitutional exception is requested.

## Complexity Tracking

No constitutional violation exists. The single new conformance package is justified by the need for
an implementation-independent, reusable adapter gate; embedding it in the control plane would prevent
isolated adapter testing, while embedding it in `backend-fake` would make the fake implementation the
owner of support semantics.

## Known Risks and Mitigations

| Risk | Mitigation / evidence gate |
|---|---|
| Common contract erases family-specific semantics | Layered common/family/capability profiles with explicit non-substitutability tests |
| Existing scheduler remains coupled to fake constants | Adapter registry port plus boundary test forbidding control-plane imports from `backend-fake` |
| Backend claims become authoritative without proof | Immutable sanitized snapshots; derived qualification/support only from complete current evidence |
| Stale probe or health creates a time-of-check/time-of-use route | Configuration/fencing identity on snapshots and mandatory start-boundary revalidation |
| Usage mixes tokens, quota, subscription, and monetary cost | Typed dimensions, provenance/confidence, no invented conversions, synthetic labels retained |
| Checkpoint portability overpromises cross-family resume | Explicit compatibility requirements and profile evidence; block rather than downgrade |
| Contract generation remains hard-coded to Feature 001 | Version-aware source manifest and reproducibility check before implementation types change |
| Additive migration breaks old evidence or restore | Legacy read mapping, additive tables, migration/backup/restore and clean-checkout regression tests |
| Deterministic corpus accidentally contacts a real service | No network/credential configuration, fixture-only adapters, security tests and explicit quickstart gate |
| Slice expands into provider console or real routing optimization | Minimum inspection only; cost/quality/semantic routing and all real adapters remain exclusions |
