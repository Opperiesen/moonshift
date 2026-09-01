# Research: Execution Backend Contracts

**Feature**: `002-execution-backend-contracts`
**Date**: 2026-09-01
**Basis**: Accepted Feature 001 implementation and evidence, Moonshift constitution and architecture,
repository exploration, and the pinned local toolchain. No current provider API or vendor behavior is
selected or relied upon in this fixture-only slice.

## R-001 — Layer a common envelope beneath semantic family profiles

**Decision**: Define a small common execution envelope and distinct versioned profiles for model APIs,
coding harnesses, and local runtimes. A test-only deterministic fixture profile preserves Feature 001
without becoming a real support family. Capability profiles extend a family profile only when an
adapter claims optional behavior.

**Rationale**: Identity, correlation, failure, usage provenance, audit, and bounded lifecycle semantics
are genuinely shared. Tool loops, artifacts, harness sessions, model modalities, local resource
discovery, and privacy semantics are not. Layering avoids both provider leakage and a lowest-common-
denominator interface that would misdescribe harnesses as model endpoints.

**Alternatives considered**:

- One universal backend interface with every field optional: rejected because incompatible semantics
  would become ambiguous and conformance could not state what is mandatory.
- Brand- or SDK-specific domain subtypes: rejected because provider types would escape adapter
  boundaries and later library changes would rewrite Moonshift state.
- Treat deterministic fake as a fourth supported production family: rejected; it is test evidence,
  not a real execution support claim.

## R-002 — Keep JSON Schema Draft 2020-12 contracts normative and version-aware

**Decision**: Continue checked-in Draft 2020-12 JSON Schemas as the normative wire artifacts, generate
TypeScript from an explicit contract-source manifest, and validate exact contract/profile versions at
runtime. Contract `2.0` has no generic extension map: compatible evolution uses only explicitly named,
Moonshift-owned optional fields whose absent meaning and compatibility fixtures are recorded;
incompatible versions fail before execution.

**Rationale**: The repository already validates Feature 001 schemas with Ajv and generates disposable
types. A source manifest removes the existing Feature 001 hard-coded path while retaining one
reproducible generation command. Explicit versions are safer than accepting arbitrary unknown fields.

**Alternatives considered**:

- TypeScript interfaces as the contract: rejected because they are erased at runtime and cannot serve
  future non-TypeScript adapters.
- Protocol Buffers in this slice: rejected because it adds a toolchain and migration without a proven
  need; JSON remains appropriate for local fixture and future HTTP/CLI adapter boundaries.
- Accept all unknown fields for forward compatibility: rejected because it conflicts with strict
  provider-private and credential-field rejection.

## R-003 — Derive qualification from immutable evidence rather than mutable adapter claims

**Decision**: Treat adapter discovery/probe/health data as bounded observations, then let Moonshift
assign identities, normalize, hash, and persist immutable snapshots bound to adapter, connection,
configuration revision, profile, lease, fence, and freshness. Derive a separate expiring
`ConnectionModelQualification`; never let an adapter write a snapshot identity, `QUALIFIED`,
`CONFORMANT`, or `SUPPORTED` directly.

**Rationale**: Adapter output is untrusted observation. Separating evidence from derived status makes
late results, contradictory claims, freshness, tampering, and audit review deterministic. It also
preserves immutable model descriptors while allowing per-connection availability to change.

**Alternatives considered**:

- Store current booleans directly on each connection: rejected because provenance, history,
  freshness, and stale-result fencing would be lost.
- Recompute all evidence synchronously during each route: rejected because route inputs would not be
  frozen or auditable and a backend outage could block historical inspection.

## R-004 — Introduce one reusable conformance package with data-driven cases

**Decision**: Add `@moonshift/backend-conformance` containing a bounded adapter port test harness,
profile/case applicability, deterministic clock/seed control, integrity report generation, and pure
support derivation. Foundation implements the minimum fixture-only family/profile and mandatory
qualification corpus required by US1; US4 extends it to the complete common/family/claimed-capability
corpus. Store cases as versioned data fixtures and keep adapter implementations in their own packages.

**Rationale**: The support gate must run independently of the control plane and be reusable by later
real adapters. Data-driven cases make required/optional applicability and deliberately broken variants
explicit without encoding support claims into each adapter.

**Alternatives considered**:

- Keep conformance tests only in repository test files: rejected because runtime/offline qualification
  and future adapter packages need the same profile semantics and reports.
- Put the framework in `backend-fake`: rejected because the subject under test must not own the gate.
- Build a plugin marketplace/remote certification service: rejected as later/public infrastructure
  far beyond this self-hosted fixture slice.

## R-005 — Make deterministic routing a pure function over a frozen snapshot

**Decision**: Build an immutable routing input containing task requirements, policy, classification,
budget/quota, capacity, checkpoint compatibility, and referenced qualification/health snapshots.
Evaluate stable exclusions first, then a versioned ordered tie-break. Persist the full decision and
revalidate referenced mutable conditions at execution start.

**Rationale**: Pure evaluation yields reproducible decisions and complete exclusion evidence. Start
revalidation closes the time-of-check/time-of-use gap without mutating past decisions. The first
strategy is intentionally minimal: pinned preference followed by stable descriptor/connection
identity, not cost or learned-quality optimization.

**Alternatives considered**:

- First healthy connection read directly from the live registry: rejected as nondeterministic,
  weakly auditable, and the source of current fake coupling.
- Adaptive or score-based quality/cost routing: rejected until real adapter evidence and the later
  evaluation/learning slice exist.
- Silent fallback that drops requirements: rejected by constitution and the specification.

## R-006 — Normalize usage without converting unlike dimensions

**Decision**: Record immutable usage dimensions with explicit unit, scope, source, confidence, and
`MEASURED`, `ESTIMATED`, `SYNTHETIC`, or `UNAVAILABLE` measurement kind. Keep quota/plan availability,
monetary cost, model units, elapsed time, and runner resources separate. Apply budgets only where
units and provenance are compatible.

**Rationale**: Feature 001 already labels fake units synthetic. Real APIs, subscriptions, harnesses,
and local runtimes expose different measurements; invented conversions would create false budget and
cost claims.

**Alternatives considered**:

- Convert all usage to tokens or currency: rejected because many harness/subscription/local metrics do
  not provide trustworthy conversion inputs.
- Store only a provider response blob: rejected because provider types would become authoritative and
  unusable for policy.

## R-007 — Extend checkpoints with compatibility requirements, not provider state

**Decision**: Preserve the Feature 001 provider-neutral checkpoint as canonical and add contract,
family/profile, capability, classification, accepted event position, and artifact/effect compatibility
requirements. Provider/harness session hints remain optional opaque references. Resume creates a
successor execution after fencing and effect reconciliation.

**Rationale**: Existing checkpoints already retain logical work, context, budgets, artifacts,
evidence, and effects. Making compatibility explicit allows safe replacement without pretending every
family supports native session resume.

**Alternatives considered**:

- Serialize provider request/session state as the checkpoint: rejected because it is provider-owned,
  potentially sensitive, and non-portable.
- Require exact connection resume: rejected because it defeats backend replaceability and recovery.
- Allow best-effort resume after capability loss: rejected because it silently weakens evidence,
  privacy, or tool guarantees.

## R-008 — Use additive normalized persistence with legacy Feature 001 read mapping

**Decision**: Add normalized backend catalog/evidence/route/usage tables in migration 004, reference
large conformance case evidence through the artifact store, and keep existing Feature 001 audit and
checkpoint rows unchanged. Map legacy fake `1.0` provenance on read; all new attempts write the new
contracts.

**Rationale**: New concepts are authoritative and queryable and should not be hidden in generic
backend projections. Additive tables preserve the completed feature's evidence and provide a clear
backup/restore boundary.

**Alternatives considered**:

- Put every snapshot/report in generic aggregate JSON: rejected because uniqueness, freshness,
  immutability, and route provenance constraints would be weak and hard to query.
- Rewrite all Feature 001 records: rejected as unnecessary risk to accepted evidence.
- Store every case payload in PostgreSQL: rejected because artifact storage already owns large,
  integrity-addressed bytes.

## R-009 — Keep Feature 002 entirely fixture-local

**Decision**: Exercise common and family-profile semantics with deterministic in-process or local
fixture adapters, no external DNS/network, no credential source, and `NONE_FIXTURE` authentication
posture. Every release is `FIXTURE` and every profile, descriptor, report, and derived claim is
`testOnly` / `TEST_FIXTURE_ONLY`, even when it simulates another semantic family. Do not update
real-provider compatibility or terms decisions.

**Rationale**: The roadmap deliberately separates general contracts from real model and harness
adapters. This permits complete deterministic proof without taking on unstable external APIs,
authentication, terms, secret isolation, or support claims.

**Alternatives considered**:

- Add one real API as a proof: rejected because it would cross into Feature 003 and activate OD-007
  and OD-010 gates.
- Fork an external orchestration product/framework: rejected because Moonshift needs owned contracts,
  state, identity, evidence, and supervisor authority rather than framework-defined semantics.

## Resolved unknowns

- **Contract ownership**: Feature 002 schemas are normative; generated TypeScript is disposable.
- **Family boundary**: shared envelope plus distinct profiles; fixture is test-only.
- **Qualification**: derived from immutable current evidence, never adapter-declared support.
- **Routing**: deterministic frozen-snapshot evaluation with start revalidation.
- **Usage**: typed dimensions without invented conversions.
- **Checkpoint portability**: explicit compatibility requirements; session hints remain optional.
- **Persistence**: additive normalized tables and legacy read mapping.
- **External dependencies**: none added; no current provider API behavior is assumed.
