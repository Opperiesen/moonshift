---

description: "Dependency-ordered implementation tasks for Execution Backend Contracts"
---

# Tasks: Execution Backend Contracts

**Input**: Design documents from `/specs/002-execution-backend-contracts/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, reviewer-owned
requirements checklists

**Tests**: Contract-first and test-first evidence is mandatory. Every story's tests must be written,
observed failing for the intended missing behavior, and recorded before success implementation.

**Organization**: Tasks are grouped by user story. Setup and Foundation are shared prerequisites; each
story ends in an independently demonstrable, revision-bound checkpoint.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Safe to run in parallel after stated prerequisites because files and decisions are disjoint
- **[Story]**: Maps the task to its specification user story
- Every task includes exact repository paths

## Phase 1: Setup and Baseline

**Purpose**: Make Feature 002 contract sources reproducible and capture the accepted Feature 001
behavior before changing shared boundaries.

- [ ] T001 Record a clean Feature 001 contract, acceptance, recovery, and security baseline bound to the starting revision in `evidence/002-execution-backend-contracts/baseline/manifest.json`
- [ ] T002 Add the normative Feature 002 contract-source/version manifest in `specs/002-execution-backend-contracts/contracts/manifest.json`
- [ ] T003 [P] Scaffold the dependency-minimal `@moonshift/backend-conformance` package and root build reference in `packages/backend-conformance/package.json`, `packages/backend-conformance/tsconfig.json`, `packages/backend-conformance/src/index.ts`, and `tsconfig.json`
- [ ] T004 [P] Add Feature 002 evidence directories and ignored runtime-output rules in `evidence/002-execution-backend-contracts/README.md` and `.gitignore`
- [ ] T005 Add failing source-manifest and generated-contract reproducibility tests in `tests/contract/execution-backend-v2-generation.test.ts`

**Checkpoint**: Baseline evidence exists and the new generation test fails only because Feature 002
contract sources are not yet integrated.

---

## Phase 2: Foundational Backend Boundary

**Purpose**: Establish versioned validation, provider-neutral domain values, deterministic adapter
port, durable storage, and fixture utilities required by every user story.

**⚠️ CRITICAL**: No user story implementation begins until T006–T018 are validated.

- [ ] T006 [P] Add failing contract boundary tests for unknown versions, exact serialized-byte/nesting/event-payload bounds, provider-private fields, credential-shaped fields, unclassified extensions, observation-to-snapshot authority, fixture-only support invariants, descriptor provenance/immutability, and a launched adapter with scrubbed credential variables plus enforced network/shell/deployment denial in `tests/contract/execution-backend-v2-schema.test.ts` and `tests/security/backend-fixture-isolation.test.ts`
- [ ] T007 [P] Add failing pure-domain and minimum-profile tests for family separation, identity invariants, backend creation time, bounded model limits, immutable initial discovery provenance, capability states, freshness, immutable descriptors, exact case applicability, report completeness, and test-only support derivation in `packages/domain/src/execution-backends.test.ts` and `packages/backend-conformance/src/profile.test.ts`
- [ ] T008 [P] Add failing migration/repository tests for immutable catalog evidence, idempotency, probe/health/report lease fencing, partial-restore rejection, and legacy reads in `tests/integration/execution-backend-catalog.test.ts`
- [ ] T009 Record the expected RED evidence for T005–T008 before success implementation in `evidence/002-execution-backend-contracts/foundation/red.json`
- [ ] T010 Extend the version-aware contract generator and checked-in source manifest handling in `scripts/generate-contract-types.mjs` and `specs/002-execution-backend-contracts/contracts/manifest.json`
- [ ] T011 Regenerate provider-neutral Feature 002 wire types, require Ajv Draft 2020-12 `strict: true` schema compilation plus version dispatch, and export validators in `packages/contracts/src/generated.ts`, `packages/contracts/src/index.ts`, and `packages/contracts/src/validators.ts`
- [ ] T012 Implement pre-schema serialized-byte and JSON-depth framing limits plus event-kind and observation-kind allowlist sanitizers with stable rejection records and no generic extension path in `packages/contracts/src/sanitizer.ts`
- [ ] T013 Implement backend catalog, qualification, execution requirement, provenance value objects, and the minimum fixture-only family/profile/case applicability and mandatory support evaluator needed by US1 in `packages/domain/src/execution-backends.ts`, `packages/domain/src/index.ts`, `packages/backend-conformance/src/profiles.ts`, `packages/backend-conformance/src/support.ts`, and `packages/backend-conformance/corpus/v1/qualification-manifest.json`
- [ ] T014 Define the generalized deterministic `ExecutionBackendAdapter` port and lifecycle result types in `packages/backend-conformance/src/adapter.ts` and `packages/backend-conformance/src/index.ts`
- [ ] T015 Add the forward-only normalized backend catalog/evidence tables and manifest entry in `packages/persistence/src/migrations/004_execution_backends.sql` and `packages/persistence/src/migrations/manifest.ts`
- [ ] T016 Implement transactional backend catalog, evidence, report, route, and usage repository primitives in `packages/persistence/src/repositories/execution-backends.ts` and export them from `packages/persistence/src/index.ts`
- [ ] T017 [P] Create deterministic clocks, identities, catalog snapshots, current/stale lease and fence values, conformant/nonconformant adapter builders, and the executable credential-scrubbed network/shell/deployment-denial harness in `tests/fixtures/execution-backends.ts`
- [ ] T018 Run the contract generation, Ajv strict-compilation, profile/support, domain, migration/repository, isolation/security boundary, typecheck, and Feature 001 baseline gates and record the Foundation checkpoint in `evidence/002-execution-backend-contracts/foundation/manifest.json`

**Checkpoint**: Generalized schemas/types/domain/storage/adapter port exist, but no connection is yet
qualified for execution.

---

## Phase 3: User Story 1 — Qualify a Backend Before Use (Priority: P1) 🎯 MVP

**Goal**: Discover deterministic backend catalog state and derive current fail-closed connection-model
qualification from sanitized probe, health, authentication, capability, and conformance evidence.

**Independent Test**: Load conformant, optional-capability, contradictory, stale, unknown-version,
tampered, unhealthy, and authentication-unavailable fixture variants; only complete current variants
become qualified, every rejection has stable reasons, and the supervisor sees safe provenance.

### Tests for User Story 1

> Write these tests first and record the intended failures before implementation.

- [ ] T019 [P] [US1] Add discovery/probe/catalog contract examples plus model-limit, initial-provenance, duplicate-immutable-field, and negative cases in `tests/contract/backend-discovery.test.ts`
- [ ] T020 [P] [US1] Add qualification truth-table and expiry tests in `packages/domain/src/backend-qualification.test.ts`
- [ ] T021 [P] [US1] Add control-plane catalog refresh, stale-result fencing, and idempotency integration tests in `tests/integration/backend-qualification.test.ts`
- [ ] T022 [P] [US1] Add secret, provider-field, contradictory-claim, oversized-discovery, forged-status, scrubbed-credential, denied-egress, denied-shell, and no-deployment adapter-launch tests in `tests/security/backend-qualification-boundaries.test.ts`
- [ ] T023 [P] [US1] Add supervisor catalog/qualification inspection acceptance coverage in `tests/acceptance/backend-qualification.spec.ts`
- [ ] T024 [US1] Record the expected RED evidence for T019–T023 in `evidence/002-execution-backend-contracts/us1/red.json`

### Implementation for User Story 1

- [ ] T025 [P] [US1] Implement deterministic fixture catalog values, adapter releases, connections, and discovery/probe variants bound to the Foundation profile and qualification corpus in `packages/backend-fake/src/catalog.ts`
- [ ] T026 [US1] Adapt `@moonshift/backend-fake` to the generalized probe/discover port, add its `@moonshift/backend-conformance` dependency/reference, and preserve Feature 001 constants through a legacy mapping in `packages/backend-fake/src/backend.ts`, `packages/backend-fake/src/index.ts`, `packages/backend-fake/package.json`, and `packages/backend-fake/tsconfig.json`
- [ ] T027 [P] [US1] Implement pure qualification, capability reconciliation, freshness, and support-status derivation in `packages/domain/src/backend-qualification.ts` and export it from `packages/domain/src/index.ts`
- [ ] T028 [US1] Implement the control-plane adapter registry and fixture-only bootstrap registration and add its `@moonshift/backend-conformance` dependency/reference in `apps/control-plane/src/application/backends/registry.ts`, `apps/control-plane/src/bootstrap/backends.ts`, `apps/control-plane/package.json`, and `apps/control-plane/tsconfig.json`
- [ ] T029 [US1] Implement leased discovery/probe, sanitizer, persistence, audit, and derived qualification orchestration in `apps/control-plane/src/application/backends/qualification-service.ts`
- [ ] T030 [US1] Add sanitized backend catalog and connection-model qualification projections in `apps/control-plane/src/projections/backend-qualification.ts`
- [ ] T031 [US1] Expose minimum loopback supervisor catalog/qualification queries in `apps/control-plane/src/http/backends.ts`, `apps/control-plane/src/http/server.ts`, and `specs/002-execution-backend-contracts/contracts/backend-supervision.openapi.yaml`
- [ ] T032 [P] [US1] Add typed browser client methods and safe view models in `apps/web/src/services/backend-api.ts`
- [ ] T033 [US1] Add the minimum supervisor qualification evidence view to Supervise in `apps/web/src/features/supervise/BackendQualification.tsx` and `apps/web/src/features/supervise/Supervise.tsx`
- [ ] T034 [US1] Run T019–T023 including the launched fixture-isolation barrier, plus Feature 001 regression, strict schema generation, migration, security, typecheck, and browser build gates, fix all failures in US1-owned files, and record exact results in `evidence/002-execution-backend-contracts/us1/validation.json`
- [ ] T035 [US1] Obtain independent security/conformance review, address every substantive finding, rerun T034 gates, record revision-bound requirements/test/browser/security/migration/review evidence in `evidence/002-execution-backend-contracts/us1/manifest.json`, and update `docs/development/current-work.md` with T036 as the first incomplete task

**Checkpoint**: User Story 1 is independently complete. Stop here before beginning portable execution.
The recommended next implementation conversation is bounded to **T001–T035** only.

---

## Phase 4: User Story 2 — Execute Through One Portable Contract (Priority: P2)

**Goal**: Start, observe, cancel, resume, and normalize usage/results through the same Moonshift-owned
contract on either qualified deterministic connection, with no scheduler dependency on fake constants.

**Independent Test**: Run identical deterministic scenarios through both qualified adapters and
broken variants; conformant outcomes have equivalent meaning and distinct provenance, unsafe output
fails closed, cancellation is explicit, and the entire Feature 001 journey remains unchanged.

### Tests for User Story 2

- [ ] T036 [P] [US2] Add portable start/event/result/failure/usage/resume contract cases in `tests/contract/execution-backend-v2-conformance.test.ts`
- [ ] T037 [P] [US2] Add ordered-event, duplicate, gap, post-terminal, cancellation-race, and usage-unit domain tests in `packages/domain/src/backend-execution.test.ts`
- [ ] T038 [P] [US2] Add adapter-registry scheduling and Feature 001 scenario integration tests in `tests/integration/portable-backend-execution.test.ts`
- [ ] T039 [P] [US2] Add malformed output, reasoning/credential leakage, unknown effect, and silent unit-conversion security tests in `tests/security/backend-execution-boundaries.test.ts`
- [ ] T040 [P] [US2] Add dual-connection portable execution and Feature 001 journey acceptance cases in `tests/acceptance/portable-backend-execution.spec.ts`
- [ ] T041 [US2] Record the expected RED evidence for T036–T040 in `evidence/002-execution-backend-contracts/us2/red.json`

### Implementation for User Story 2

- [ ] T042 [P] [US2] Implement ordered event/result/cancellation/usage acceptance rules in `packages/domain/src/backend-execution.ts`
- [ ] T043 [US2] Implement generalized start, cancel, and resume behavior for conformant and broken deterministic adapters in `packages/backend-fake/src/backend.ts` and `packages/backend-fake/src/variants.ts`
- [ ] T044 [US2] Implement adapter invocation, event validation/deduplication, terminal enforcement, and normalized failure handling in `apps/control-plane/src/application/backends/execution-service.ts`
- [ ] T045 [US2] Persist normalized event, terminal result, cancellation, and usage provenance in `packages/persistence/src/repositories/execution-backends.ts` and `apps/control-plane/src/projections/backend-execution.ts`
- [ ] T046 [US2] Replace direct fake constants/factory selection with the qualified adapter registry in `apps/control-plane/src/scheduler/index.ts`
- [ ] T047 [US2] Route Feature 001 approval continuation and backend execution completion through the generalized service in `apps/control-plane/src/application/supervision/commands.ts`
- [ ] T048 [US2] Add execution, cancellation, usage, and adapter provenance to existing result projections without exposing raw backend output in `apps/control-plane/src/projections/result-detail.ts` and `apps/web/src/features/results/Results.tsx`
- [ ] T049 [US2] Enforce the no-control-plane-import-from-`backend-fake` dependency rule in `scripts/check-boundaries.mjs`
- [ ] T050 [US2] Run T036–T040 plus the full Feature 001 journey, runner, recovery, security, generation, typecheck, and browser gates, fix all failures in US2-owned files, and record exact results in `evidence/002-execution-backend-contracts/us2/validation.json`
- [ ] T051 [US2] Record revision-bound portable-contract, cancellation, usage, sanitization, and regression evidence in `evidence/002-execution-backend-contracts/us2/manifest.json`

**Checkpoint**: User Stories 1 and 2 work independently; every execution uses the generalized adapter
port and Feature 001 behavior remains regression-clean.

---

## Phase 5: User Story 3 — Route and Recover Deterministically (Priority: P3)

**Goal**: Select only qualified candidates from a frozen snapshot, persist complete exclusion and
tie-break evidence, revalidate at start, and resume safely from compatible checkpoints.

**Independent Test**: Re-evaluate a fixed mixed candidate set and obtain the same decision bytes;
invalidate the selected candidate before start and require a successor route; lose a runtime and resume
on a compatible connection without identity change or duplicate effect while incompatible checkpoints
block.

### Tests for User Story 3

- [ ] T052 [P] [US3] Add route-decision schema examples, exclusion reason, selected/blocked/queued, and revalidation contract cases in `tests/contract/backend-routing.test.ts`
- [ ] T053 [P] [US3] Add pure 100-candidate eligibility, stable ordering, tie-break, no-downgrade, and decision-hash tests in `packages/domain/src/backend-routing.test.ts`
- [ ] T054 [P] [US3] Add route persistence, concurrent invalidation, and start-boundary revalidation integration tests in `tests/integration/backend-routing.test.ts`
- [ ] T055 [P] [US3] Add checkpoint compatibility, fencing, successor execution, and no-duplicate-effect recovery tests in `tests/recovery/backend-routing-checkpoint.test.ts`
- [ ] T056 [P] [US3] Add stale qualification, forged compatibility, privacy downgrade, and authority-race security cases in `tests/security/backend-routing-boundaries.test.ts`
- [ ] T057 [P] [US3] Add supervisor route reasons, block, stale reroute, and recovery acceptance cases in `tests/acceptance/backend-routing.spec.ts`
- [ ] T058 [US3] Record the expected RED evidence for T052–T057 in `evidence/002-execution-backend-contracts/us3/red.json`

### Implementation for User Story 3

- [ ] T059 [P] [US3] Implement immutable execution requirements, routing snapshots, exclusion codes, and stable route evaluator in `packages/domain/src/backend-routing.ts`
- [ ] T060 [P] [US3] Add checkpoint profile/capability/classification/event/usage compatibility requirements and validation in `apps/control-plane/src/application/recovery/checkpoints.ts`
- [ ] T061 [US3] Implement route snapshot construction, persistence, selection, and start revalidation in `apps/control-plane/src/scheduler/router.ts` and `apps/control-plane/src/scheduler/index.ts`
- [ ] T062 [US3] Generalize connection-switch planning from fake constants to qualification/checkpoint compatibility evidence in `apps/control-plane/src/scheduler/backend-switch.ts`
- [ ] T063 [US3] Integrate lost-runtime fencing, effect reconciliation, context recompilation, successor routing, and blocked incompatibility in `apps/control-plane/src/application/recovery/service.ts`
- [ ] T064 [US3] Project durable candidate exclusions, route succession, checkpoint compatibility, and recovery reasons and add the authenticated route-inspection endpoint in `apps/control-plane/src/projections/backend-execution.ts`, `apps/control-plane/src/http/backends.ts`, `apps/web/src/features/results/Results.tsx`, and `specs/002-execution-backend-contracts/contracts/backend-supervision.openapi.yaml`
- [ ] T065 [US3] Run T052–T057 plus crash matrix, Feature 001 backend switch/recovery, security, persistence, generation, typecheck, and browser gates, fix US3 failures, and record exact results in `evidence/002-execution-backend-contracts/us3/validation.json`
- [ ] T066 [US3] Record revision-bound route determinism, revalidation, checkpoint, fencing, reconciliation, browser, and review evidence in `evidence/002-execution-backend-contracts/us3/manifest.json`

**Checkpoint**: User Stories 1–3 are independently demonstrable; routing and recovery are generalized,
deterministic, and fail closed.

---

## Phase 6: User Story 4 — Prove Adapter Compatibility (Priority: P4)

**Goal**: Run a versioned deterministic common/family/capability corpus, persist integrity-addressed
case evidence and reports, and derive support only from complete current mandatory evidence.

**Independent Test**: Repeat the corpus on conformant, optional-capability, and broken variants; exact
normalized outcomes reproduce, every mandatory failure blocks support, and reports remain traceable to
all governing versions without becoming real-provider claims.

### Tests for User Story 4

- [ ] T067 [P] [US4] Add profile, corpus manifest, per-case seed/clock/budget inheritance, case applicability, report, summary, and compatibility contract examples and negative tests in `tests/contract/backend-conformance-report.test.ts`
- [ ] T068 [P] [US4] Add pure applicability, completeness, expiry, integrity, test-only, and support-derivation tests in `packages/backend-conformance/src/support.test.ts`
- [ ] T069 [P] [US4] Add deterministic repeated-run and broken-variant corpus tests in `packages/backend-conformance/src/corpus-runner.test.ts`
- [ ] T070 [P] [US4] Add report/artifact transaction, late-run fencing, idempotency, and support refresh integration tests in `tests/integration/backend-conformance.test.ts`
- [ ] T071 [P] [US4] Add tampered/incomplete/unknown-version/self-certification and credential-leak security tests in `tests/security/backend-conformance-boundaries.test.ts`
- [ ] T072 [P] [US4] Add supervisor conformance evidence traceability acceptance coverage in `tests/acceptance/backend-conformance.spec.ts`
- [ ] T073 [US4] Record the expected RED evidence for T067–T072 in `evidence/002-execution-backend-contracts/us4/red.json`

### Implementation for User Story 4

- [ ] T074 [P] [US4] Extend the minimum qualification corpus into the complete common, family, and claimed-capability profile manifests plus bounded case fixtures in `packages/backend-conformance/src/profiles.ts` and `packages/backend-conformance/corpus/v1/manifest.json`
- [ ] T075 [P] [US4] Implement case applicability, deterministic clock/seed/budget execution, normalized evidence hashing, and cancellation in `packages/backend-conformance/src/corpus-runner.ts`
- [ ] T076 [P] [US4] Implement immutable report assembly, completeness/integrity validation, expiry, and support derivation in `packages/backend-conformance/src/report.ts` and `packages/backend-conformance/src/support.ts`
- [ ] T077 [US4] Implement leased conformance orchestration, artifact/report persistence, stale-run fencing, audit, and qualification refresh in `apps/control-plane/src/application/backends/conformance-service.ts`
- [ ] T078 [US4] Add report/profile/corpus/support provenance plus the authenticated conformance-report endpoint to backend queries and supervisor projections in `apps/control-plane/src/http/backends.ts`, `apps/control-plane/src/projections/backend-qualification.ts`, `apps/web/src/features/supervise/BackendQualification.tsx`, and `specs/002-execution-backend-contracts/contracts/backend-supervision.openapi.yaml`
- [ ] T079 [US4] Run T067–T072 against all deterministic variants twice with identical inputs, run Feature 001/US1–US3 regressions, fix US4-owned failures, and record exact results in `evidence/002-execution-backend-contracts/us4/validation.json`
- [ ] T080 [US4] Record revision-bound corpus, profile, report, support, artifact, browser, security, and review evidence in `evidence/002-execution-backend-contracts/us4/manifest.json`

**Checkpoint**: All four stories are independently functional and no adapter can be described as
supported without complete current deterministic evidence.

---

## Phase 7: Hardening and Cross-Cutting Proof

**Purpose**: Prove migration/recovery/security/performance/documentation completeness and converge the
whole feature without expanding into real adapters.

- [ ] T081 [P] Extend migration upgrade, clean-database, legacy-read, and exact catalog/report/route/usage backup/restore coverage in `tests/recovery/backup-restore.test.ts`
- [ ] T082 [P] Add crash boundaries before/during/after probe, qualification, report, support, route, start, cancel, result, usage, checkpoint, and resume in `tests/recovery/backend-contracts-crash-matrix.test.ts`
- [ ] T083 [P] Add the combined zero-leakage, zero-downgrade, unknown-version, stale-evidence, tamper, and no-external-network matrix in `tests/security/security-boundaries.test.ts`
- [ ] T084 [P] Add bounded 100-candidate routing and 500-case corpus resource/latency evaluation in `tests/performance/backend-contracts-capacity.test.ts` and `config/observability/reference-capacity.json`
- [ ] T085 [P] Document backend family/profile semantics, qualification, usage, routing, checkpoint compatibility, and support limitations in `docs/architecture/execution-backends.md` and `docs/architecture/routing-and-checkpoints.md`
- [ ] T086 [P] Document fixture-only local evaluation, failure diagnosis, migration, backup/restore, and explicit no-real-support posture in `docs/operations/backend-contracts.md`, `README.md`, and `SECURITY.md`
- [ ] T087 Run every quickstart scenario and write revision-bound test, browser, migration, recovery, security, capacity, and coverage reports in `evidence/002-execution-backend-contracts/full/`
- [ ] T088 Run `pnpm clean && pnpm validate`, acceptance, web build, generated-contract `--check`, clean-checkout, and `git diff --check` gates and record exact commands/results in `evidence/002-execution-backend-contracts/full/final-validation.json`
- [ ] T089 Run `$speckit-converge`, implement any appended tasks, repeat until zero findings remain, and record the final report in `evidence/002-execution-backend-contracts/full/convergence.json`
- [ ] T090 Obtain independent final review of contracts, family semantics, migration, persistence, routing, recovery, security, scope, tests, and evidence and record resolved findings in `evidence/002-execution-backend-contracts/full/review.json`
- [ ] T091 Mark reviewer-owned requirements checklists complete only from explicit reviewer determinations in `specs/002-execution-backend-contracts/checklists/`
- [ ] T092 Update durable handoff with the final feature state, validations, branch, commit, first incomplete task, limitations, and next action in `docs/development/current-work.md`

**Final Checkpoint**: Feature 002 is complete only when all tasks are checked, all required checklists
are reviewer-approved, deterministic validation passes, convergence has zero findings, independent
review has no unresolved substantive finding, and no real backend/support claim has entered scope.

---

## Dependencies & Execution Order

### Phase dependencies

```text
Setup T001–T005
  └─ Foundation T006–T018
       └─ US1 T019–T035
            └─ US2 T036–T051
                 └─ US3 T052–T066
                      └─ US4 T067–T080
                           └─ Hardening T081–T092
```

- Setup has no implementation dependency and establishes reproducibility plus accepted baseline.
- Foundation blocks every story because all stories need owned contracts, domain invariants, adapter
  port, persistence, and deterministic fixtures.
- US1 is the MVP and establishes the only candidate set US2 may execute.
- US2 depends on US1 qualification and migrates Feature 001 through the portable port.
- US3 depends on US1 eligibility and US2 execution/cancellation/checkpoint semantics.
- US4 consumes the port and qualification rules from US1/US2; it follows US3 so complete reports and
  routes expose the same final provenance model.
- Hardening depends on every desired story.

### Within each story

1. Add contract/domain/integration/security/acceptance tests.
2. Run and record the intended RED evidence.
3. Implement pure domain/contracts before persistence/application/projection integration.
4. Run the story's targeted gates and all preceding-story regression gates.
5. Obtain review appropriate to the story risk and write revision-bound evidence.
6. Stop at the checkpoint before starting the next story.

### Parallel opportunities

- T003 and T004 can run in parallel after T001–T002 ownership is clear.
- Foundation contract/security (T006), domain/profile (T007), and repository (T008) RED-test writers
  own disjoint files before T009 records their common evidence; T017 fixture work is disjoint after the
  foundational contracts and port exist.
- Within each story, tasks marked `[P]` are disjoint test or pure-module paths; implementation tasks
  that converge on scheduler, persistence, or projections are intentionally sequential.
- Hardening test/document tasks T081–T086 are independent before integrated evidence T087–T092.

## Parallel Example: User Story 1

```text
Task T019: contract discovery/probe cases in tests/contract/backend-discovery.test.ts
Task T020: qualification truth table in packages/domain/src/backend-qualification.test.ts
Task T021: persistence/application integration in tests/integration/backend-qualification.test.ts
Task T022: trust-boundary negatives in tests/security/backend-qualification-boundaries.test.ts
Task T023: browser acceptance in tests/acceptance/backend-qualification.spec.ts
```

After their common RED evidence is recorded, T025 and T027 may proceed in parallel because the fake
catalog implementation and pure qualification evaluator own disjoint modules. T026 then integrates
the adapter port; T028–T033 proceed in dependency order.

## Implementation Strategy

### Next bounded checkpoint: User Story 1 only

1. Complete T001–T005 and record the baseline.
2. Complete T006–T018 and validate the generalized foundation.
3. Complete T019–T035 and prove backend qualification independently.
4. Stop, review, commit, and update `current-work.md` with T036 as the first incomplete task.
5. Do not begin US2 in the same checkpoint unless the supervisor separately authorizes that range.

### Incremental delivery

1. Qualification makes the catalog trustworthy without changing execution behavior.
2. Portable execution removes fake coupling while preserving Feature 001.
3. Deterministic routing and recovery operationalize replaceability.
4. Full conformance evidence makes future support claims objective.
5. Hardening proves migration, recovery, security, bounded resource use, and scope.

## Notes

- `[P]` means different files and no dependency on an incomplete task beyond the stated phase.
- Test tasks precede success implementation and must have recorded intended failures.
- Task checkboxes remain authoritative execution state; evidence and `current-work.md` are navigation
  records, not parallel task databases.
- No task authorizes real credentials, external provider calls, unrestricted shell, deployment,
  remote Git mutation, public support claims, or resolution of open decisions.
- The first implementation task range is **T001–T035**; every later task remains prohibited until the
  US1 checkpoint is separately advanced.
