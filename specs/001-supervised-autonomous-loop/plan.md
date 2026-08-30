# Implementation Plan: Supervised Autonomous Loop

**Branch**: `main` (Iteration 0 planning baseline) | **Date**: 2026-08-31 | **Spec**:
[spec.md](spec.md)

**Input**: Feature specification from `specs/001-supervised-autonomous-loop/spec.md`

**Note**: This plan and its design artifacts are the final production-design output of Iteration 0.
Production implementation begins only in a later bounded `$speckit-implement` phase.

## Summary

Build one demonstrable supervised objective-to-verified-result loop with real domain transitions,
durability, policy, approval, idempotency, reconciliation, independent verification, and browser
projection, while all cognitive and repository behavior remains deterministic and fixture-controlled.

The implementation will be a pnpm TypeScript monorepo on Node.js 24 LTS. A modular control plane owns
PostgreSQL-backed state, audit/events/outbox, scheduling, policy, context, verification, HTTP commands,
and SSE projections. A separate capability-minimal runner process executes only controlled fixture
operations. A React browser provides Project, Observe, Supervise, and Results views. Moonshift-owned
JSON Schema/OpenAPI contracts separate the domain, browser, fake backend, and runner. Artifact bytes
use a local content-addressed store behind an interface. The runner uses owner-local per-instance
mutual-TLS identity. No real provider/user credential, arbitrary shell, production deployment, or
remote mutation is included.

## Technical Context

**Language/Version**: Node.js `24.x` LTS; TypeScript `7.0.2`; browser-standard HTML/CSS/JavaScript

**Primary Dependencies**: pnpm `11.24.0`; Vite `8.2.2`; `@vitejs/plugin-react` `6.1.1`; React
`19.2.8`; Fastify `5.12.1`; node-postgres `8.23.0`; Ajv `8.20.0`; build-only
`@sourcemeta/jsonschema` `16.8.0`; JSON Schema Draft 2020-12 for boundary contracts (Fastify route
schemas use the supported draft subset or precompiled validators); Vitest `4.1.11`; Playwright
`1.62.1`; exact transitive versions pinned by lockfile

**Storage**: PostgreSQL 18 for authoritative state, events, outbox, queue, leases, checkpoints,
idempotency, and metadata; content-addressed owner-local filesystem for fixture artifacts behind an
interface

**Testing**: Vitest unit/contract/integration suites; disposable real PostgreSQL 18; Playwright browser
acceptance; deterministic clock/IDs/scripts; process restart, crash-boundary, replay, idempotency,
authorization, and reference-capacity suites

**Target Platform**: Linux control-plane and runner processes; evergreen desktop browser; local macOS
or Linux development; production-oriented target is a 16 GB Proxmox VE host with a dedicated Linux
runner VM and remote inference (simulated in this slice)

**Project Type**: Browser web application, modular API/control-plane service, separate runner daemon,
and administration CLI in one monorepo

**Performance Goals**: At three concurrent fake cognitive executions, 95% of committed events visible
within 2 seconds; at five, within 5 seconds; supervisor control command durably acknowledged within 2
seconds; project inspectable within 60 seconds after restart

**Constraints**: One supervisor; loopback-only evaluation; three default and five maximum cognitive
executions; one runner job for the acceptance path; approximately 2–3 GB control-plane and at most
6 GB one-job runner envelopes; no local GPU, real provider, provider/user credential, unrestricted shell,
unapproved network, remote Git write, or production deployment

**Scale/Scope**: One active project; default three personas and four active specialists within six/eight
ceilings; 24 default and 64 maximum active channels; depth four; eight direct children; one bounded
task and specialist in the reference journey; durable replay and crash matrix prioritized over
throughput

## Constitution Check

### Pre-design gate

| Constitutional gate | Result | Design evidence |
|---|---|---|
| Human sovereignty and one-supervisor scope | PASS | Supervisor-only approval/control contracts; loopback bootstrap; no multi-human model |
| Identity independent from runtime/provider | PASS | Separate identity, runtime, backend, connection, backend-scoped model descriptor/version, connection-availability relation, and optional session entities |
| Moonshift-owned authoritative state | PASS | PostgreSQL aggregates/event/outbox plus content-addressed artifacts; provider state is optional |
| Model API and harness family separation | PASS | `ExecutionBackend` family contract retained; only family-neutral fake implementation in slice |
| Replaceable, conformant adapters and owned types | PASS | Versioned backend schema and deterministic fake conformance suite |
| Evidence-based completion and ground truth | PASS | Verification rules bind artifacts/tests/review to fixture Git revision; claim stops at `CLAIMED_COMPLETE` |
| Bounded autonomy and independent Quality | PASS | Central policy profile, subset grants, depth one, lineage validation |
| Least privilege and plane separation | PASS | Separate mutually authenticated runner process, fenced capability-only fixture operations, no shell or provider credentials |
| Audit, durable effects, idempotency, reconciliation | PASS | Atomic state/event/outbox, semantic idempotency, fencing, crash matrix |
| Compiled minimized context | PASS | `ContextManifest` contract; no implicit raw chat context |
| Official authentication and terms | PASS | No real provider auth; fake backend uses `NONE_FIXTURE`; runner identity is owner-local mutual TLS |
| Self-hosting, reproducibility, reversibility | PASS | Owner-local state, pinned stack, migration/backup/restore plan, reference-host tests |
| Incremental vertical delivery | PASS | One controlled end-to-end journey with explicit exclusions |
| Versioned agent behavior and governed learning | PASS | Persona/policy versions recorded; no self-improvement |

There are no constitutional exceptions. Design stops if any later implementation task would require
one; the exception process cannot be satisfied implicitly.

## Architecture

### Dependency direction

```text
Browser adapters -----> HTTP/event contracts <----- Control-plane adapters
                                                  |
                                                  v
                                   Application commands / queries
                                                  |
                                                  v
                               Domain + policy + verification rules
                                                  |
                                                  v
                   Persistence / artifacts / outbox / fake backend / runner adapters

Separate runner <---- versioned runner contract ----> control-plane scheduler
```

Domain packages import no Fastify, React, PostgreSQL, runner, or backend implementation type. The
application layer orchestrates commands against domain ports. Adapters translate external schemas to
owned commands and persist aggregate changes transactionally.

### Command and event path

1. An HTTP command carries actor, idempotency key, expected aggregate version, and correlation ID.
2. The application service loads current state, validates policy/authority/transition, and applies the
   domain command.
3. Aggregate state, immutable audit/domain event, idempotency result, and outbox row commit together.
4. Projection and scheduler workers claim work with leases and `SKIP LOCKED`; `NOTIFY` may wake them
   but durable polling is authoritative.
5. SSE reads durable project-sequenced events. The browser deduplicates by event ID and reloads a
   projection when a cursor has expired.

### Execution and runner path

The scheduler creates an Execution and leases a healthy conformant fake connection, budget, tools,
and one registered fixture runner. The Context Compiler produces a manifest and fixture input. The
runner accepts only loopback mutual-TLS streams whose certificate identity matches the enrolled
instance/runner message identity, then schema-validates the fixture operation and current fencing
token. Replay, revoked identity, identity mismatch, stale lease/result binding, and plaintext fail
closed. The runner persists effect intent through the control plane and mutates a queryable fixture
ledger only after approval.

Two fake backend instances implement identical scripts and checkpoint semantics. Runtime loss revokes
the old fencing token, transitions through `LOST`/`RECONCILING`, queries fixture ground truth for every
uncertain effect, compiles a new context, and resumes the same SpecialistIdentity on the second
connection.

### Verification path

The specialist publishes a hashed artifact at the expected fixture revision and claims completion.
Quality receives a separate reviewer identity/lineage and deterministic evidence fixtures. The
Verification Engine evaluates the versioned rule set in one recorded evaluation. Only a complete pass
at the expected revision transitions the Task to `VERIFIED`; a changed policy, revision, evidence set,
or evidence hash makes the captured evaluation `STALE` and requires a fresh snapshot. Every other
outcome is explicit and repairable or terminal according to policy.

### Browser surfaces

- **Projects**: objective submission and current project state.
- **Observe**: nested channel tree, reloadable durable-source agent presence, task/dependency summary,
  and ordered event stream with an explicit expired-cursor projection reset.
- **Supervise**: pending approval detail, budgets/capacity, pause/resume/cancel/stop, blocked work.
- **Results**: actual task state, artifact hash/revision, evidence matrix, Quality lineage, approvals,
  execution/checkpoint history, and audit timeline.

The first UI uses accessible semantic HTML, keyboard-operable controls, visible focus, status text in
addition to color, loading/empty/error/reconnect states, and deterministic selectors for acceptance.

## Data, Contracts, and Security Design

The detailed entities, invariants, and transitions are in [data-model.md](data-model.md). The external
surface is versioned in [contracts/](contracts/): HTTP/OpenAPI, event envelope, execution backend,
runner protocol, and fake-backend scenario contract. Contract files are planning inputs and become
executable validation sources during implementation.

Security follows the repository [security model](../../docs/architecture/security-model.md). The
slice adds concrete negative tests for capability escalation, child spawning, self-approval, action-
digest replay, same-lineage review, path traversal, oversized/tampered artifacts, stale fencing,
forged/replayed/revoked runner identities, unauthorized event access, raw-chat context inclusion, and
credential/path/private-reasoning shaped data in backend projections, logs, events, evidence, and UI.
It performs no real network effect and binds the service to loopback. A one-time owner-local browser
bootstrap exchange establishes a host-only HttpOnly supervisor session; the secret travels only in a
browser fragment, is removed immediately, is never printed or logged, and cannot be reused.
All backend observations first pass one kind-specific bounded allowlist sanitizer; raw source objects
are never persisted or published.

## Migration, Backup, and Restore

- Store numbered, forward-only SQL migrations in Git and record checksum/application history.
- Apply each migration under an exclusive migration lock; reject modified applied migrations.
- Test a clean migration and an upgrade from the immediately previous fixture schema.
- Keep startup migration explicit in the administration workflow, not a hidden destructive side effect.
- Create a consistent evaluation backup from a database dump, artifact tree, configuration with opaque
  secret references only, and a version/hash manifest.
- Restore into a stopped scheduler, validate schema compatibility and artifact hashes, rebuild
  projections, then resume scheduling.
- Measure final backup size, temporary backup/restore working-space high-water marks, and scheduling
  downtime from stop through validated rebuild against the reference disk envelope.
- If a migration cannot be reversed safely, rollback means restoring the pre-upgrade backup; this
  limitation must be visible.

Slice 001 implements migration and fixture-level backup/restore acceptance sufficient to establish the
contract. General retention and production backup scheduling remain later human/feature decisions.

## Performance and Resource Validation

The capacity suite runs the deterministic journey at one, three, and five concurrent cognitive
executions while holding standard fixture work constant. It records browser event commit-to-display
latency, HTTP command durability latency, queue wait reason/duration, PostgreSQL connections/locks,
process memory high-water mark, runner lease utilization, outbox lag, and restart/recovery time.
It also records CPU, memory, process, disk, maximum-runtime, network, and optional-GPU requests and
enforcement evidence, rootless discovery facts, backup/restore storage high-water marks, and restore
downtime.

The run fails if constitutional ceilings are exceeded, process memory crosses the documented envelope,
events are missing/duplicated, p95 goals fail, stop/approval correctness changes under load, any
requested resource is not enforceable, backup working space exceeds the declared disk envelope, or
scheduling resumes before restore validation. A second runner job and OCI profile are not claimed or
enabled by this slice.

## Test Strategy and Evidence

| Layer | Required evidence |
|---|---|
| Domain unit | Complete transition tables, illegal-transition rejection, policy limits, lineage, budget subsets, verification rule matrix |
| Contract | JSON Schema/OpenAPI validity, examples, strict sanitizer rejection, backward-compatible event reader, fake backend and authenticated runner conformance |
| Persistence integration | Real PostgreSQL transactions, optimistic concurrency, outbox atomicity, queue claiming, idempotency, lease/fencing |
| Artifact integration | Atomic write/hash/read, tamper/missing/oversize/path traversal, backup/restore |
| Process integration | Control plane and mutual-TLS runner startup/health/revocation, loss detection, cancellation, checkpoint switch, reconciliation |
| Browser acceptance | Full 16-step journey plus rejection, evidence failure, pause/verification interlock, stop, expired-cursor presence reload, reconnect, and Results states |
| Crash matrix | Interrupt at each durable boundary before/during/after effect and outbox publication; prove no duplicate effect |
| Capacity | Default three and ceiling five cognitive runs on reference envelope; collect SC-006–SC-008 metrics |
| Security | Negative capability, approval, lineage, runner authentication/replay, projection sanitizer, context, artifact, and audit tests |
| Restore | Recreate full authoritative state and projection from consistent backup set; record storage high-water and downtime |

The acceptance evidence bundle records the exact Git revision, migration version, contract hashes,
policy/persona versions, test reports, capacity metrics, artifact hashes, Quality review, and unresolved
findings.

## Project Structure

### Documentation (this feature)

```text
specs/001-supervised-autonomous-loop/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── README.md
│   ├── http-api.openapi.yaml
│   ├── event-envelope.schema.json
│   ├── execution-backend.schema.json
│   ├── runner-protocol.schema.json
│   └── fake-backend.md
├── checklists/
│   ├── requirements.md
│   └── eight reviewer-owned quality checklists
└── tasks.md
```

### Source Code (repository root; planned, not created in Iteration 0)

```text
apps/
├── control-plane/
│   └── src/
│       ├── bootstrap/
│       ├── http/
│       ├── application/
│       ├── scheduler/
│       └── projections/
├── web/
│   └── src/
│       ├── app/
│       ├── features/
│       ├── components/
│       └── services/
├── runner/
│   └── src/
│       ├── daemon/
│       ├── leases/
│       └── fixture/
└── cli/
    └── src/
packages/
├── domain/src/
├── contracts/src/
├── persistence/src/
│   ├── migrations/
│   └── repositories/
├── policy/src/
├── verification/src/
├── context/src/
├── artifacts/src/
├── backend-fake/src/
└── test-fixtures/src/
fixtures/
└── supervised-loop-repository/
tests/
├── contract/
├── integration/
├── acceptance/
├── recovery/
├── security/
└── performance/
```

**Structure Decision**: A pnpm monorepo keeps contracts and test fixtures atomic while applications
remain independently startable. The control plane is a modular monolith. The runner is a separate
process from its first task. Packages are organized by domain boundary, not by framework. No provider
adapter or general shell package is created in this slice.

## Implementation Phases

1. **Setup**: Pin toolchain, monorepo, validation, controlled fixture, and local PostgreSQL workflow.
2. **Foundation**: Contracts, domain states, persistence/outbox/idempotency, policy, audit, strict event
   projection sanitizer, artifacts, context manifest, fake-minimum conformance, and mutually
   authenticated runner lease boundary.
3. **Start and observe**: Objective, project/default council, channel/delegation, fake execution, SSE,
   and Projects/Observe UI.
4. **Govern work**: Tool policy, action-bound approval, supervisor decisions, budgets, distinct
   pause/resume/stop/cancel semantics, Supervise UI.
5. **Verify evidence**: Artifact/evidence pipeline, independent Quality lineage, deterministic
   Verification Engine, Results evidence matrix.
6. **Recover and switch**: Checkpoints, restart, runtime loss, fencing, reconciliation, second fake
   connection, event replay.
7. **Harden and prove**: Full acceptance, crash/idempotency/security/capacity/backup-restore evidence,
   docs, and convergence.

Each story phase must pass its independent acceptance test before the next story is treated as
complete. Setup/foundation implementation is the recommended first bounded `$speckit-implement` run.

## Post-design Constitution Check

All pre-design gates remain `PASS` after the data model and contracts:

- No provider or framework type appears in identity, checkpoint, domain, or event contracts.
- Backend API/harness/local families remain distinct even though only a fake backend is implemented.
- The runner is a real mutually authenticated process/lease/fencing boundary with no shell or provider
  credential access.
- State, effect, approval, evidence, context, and audit invariants are explicit and testable.
- Quality lineage, human approval/control, policy ceilings, loopback posture, and data sovereignty are
  enforced by contracts and tasks rather than prose alone.
- Backup/restore, migration, capacity, supply-chain pinning, and revision-bound evidence have planned
  gates.
- The backend contract is explicitly the deterministic fake minimum; general backend-family
  conformance and production deployment remain later roadmap concerns.

**Gate result**: PASS — design complete; task decomposition and final consistency analysis are
recorded, and the independent requirements review accepted all 122/122 custom checklist items.

## Complexity Tracking

No constitutional violation or exception is required. The four planned applications reflect the
three product components plus the browser surface; they share one repository and one modular domain,
not four independent services. PostgreSQL is the only required state service, and the first runner
exposes only fixture operations.

## Known Risks and Mitigations

| Risk | Mitigation / evidence gate |
|---|---|
| Slice breadth becomes a hidden full product | Strict fixture-only operations; implement setup/foundation first; converge by story |
| State-machine inconsistency across layers | Pure domain transition tests plus schema/contract generation and analysis |
| PostgreSQL queue starvation or duplicate claims | Bounded queues, `SKIP LOCKED` only for claims, leases/fencing, concurrency tests |
| SSE cursor gap or duplicate display | Durable sequence, dedupe, cursor-expired reset contract, reconnect acceptance |
| Fake runner masks isolation assumptions | Explicitly label capability-minimal; no shell; separate process; defer OCI support claim |
| Crash matrix becomes nondeterministic | Scripted fault injection, fake clock, queryable effect ledger, fixed seeds |
| UI work delays domain proof | Story-aligned minimal accessible surfaces; no design system or unrelated dashboard scope |
| Current dependency behavior changes | Exact lockfile, automated compatibility checks, dated research, controlled upgrades |
