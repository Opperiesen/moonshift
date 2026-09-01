# Data Model: Execution Backend Contracts

**Feature**: `002-execution-backend-contracts`
**Date**: 2026-09-01

## Modeling rules

- All identifiers are Moonshift-owned UUIDs unless explicitly described as a content hash or external
  opaque hint.
- Agent identity, runtime, execution, backend descriptor, adapter release, connection, model
  descriptor, route, conformance run, and optional provider session are distinct.
- Observations are immutable. Current qualification and support are deterministic derived views over
  referenced evidence; adapters cannot assign those states directly.
- Model descriptors are immutable for `(model_descriptor_id, version)`. Connection-specific facts
  never mutate or duplicate a descriptor.
- Every mutable configuration uses a monotonically increasing revision. Probe, health, conformance,
  and route evidence is valid only for the exact revision and fence it names.
- Provider-private payloads, credentials, cookies, private reasoning, raw transcripts, and arbitrary
  paths are not model fields.

## BackendFamilyProfile

Defines one semantic contract family and its conformance obligations.

| Field | Type / rule |
|---|---|
| `profileId` | Stable namespaced string |
| `version` | Positive integer |
| `familyKind` | `MODEL_API`, `CODING_HARNESS`, `LOCAL_RUNTIME`, or test-only `DETERMINISTIC_FIXTURE` |
| `contractMajor` | Supported common-contract major version |
| `requiredCapabilities` | Sorted unique capability IDs |
| `optionalCapabilities` | Sorted unique capability IDs disjoint from required |
| `mandatoryCaseIds` | Sorted unique conformance case IDs |
| `compatibilityRules` | Explicit accepted profile/contract ranges and resume rules |
| `testOnly` | Must be true for every profile in this fixture-only slice |
| `supportScope` | `TEST_FIXTURE_ONLY` in this slice |

Validation: a fixture may simulate any family kind while remaining test-only. Production support
claims cannot target any Feature 002 profile. Family kinds are not substitutable unless a route
requirement explicitly permits several profiles and each independently qualifies.

## BackendDescriptor

Stable backend boundary identity independent of connection and adapter process.

| Field | Type / rule |
|---|---|
| `backendId` | UUID |
| `familyKind` | Exact semantic family simulated by this descriptor |
| `familyProfileId/version` | Exact profile reference |
| `name` | Owner-visible non-secret label |
| `testOnly` / `supportScope` | `true` / `TEST_FIXTURE_ONLY` |
| `lifecycle` | `ACTIVE`, `DISABLED`, `RETIRED` |
| `createdAt` | Timestamp |

Relationship: one descriptor has many adapter releases, connections, and immutable model descriptor
versions. Disabling a descriptor prevents new qualification/routes but preserves history.

## AdapterRelease

Identifies executable translation code without making it authoritative.

| Field | Type / rule |
|---|---|
| `adapterReleaseId` | UUID |
| `backendId` | Exact descriptor reference |
| `adapterName` | Stable package/implementation name |
| `adapterVersion` | Immutable semantic version string |
| `supportedContractRange` | Explicit common contract range |
| `supportedProfileRange` | Exact family profile/range |
| `implementationKind` | `FIXTURE` in this slice; future `REAL` remains gated |
| `contentHash` | `sha256:` integrity reference for the implementation manifest |

Unique: `(backend_id, adapter_name, adapter_version)`.

## BackendConnection

Owner-configured adapter instance.

| Field | Type / rule |
|---|---|
| `connectionId` | UUID |
| `backendId` / `adapterReleaseId` | Exact references |
| `name` | Owner-visible unique label |
| `configurationRevision` | Positive monotonically increasing integer |
| `authenticationMode` | `NONE_FIXTURE` only in this slice |
| `authenticationStatus` | `AVAILABLE`, `UNAVAILABLE`, `EXPIRED`, `MISCONFIGURED`, `UNKNOWN` |
| `credentialReference` | Null in this slice; future opaque reference only |
| `lifecycle` | `ENABLED`, `DISABLED`, `RETIRED` |
| `updatedAt` | Timestamp |

Changing executable configuration creates a new revision and invalidates prior qualification. Secret
material is never stored in this entity.

## ModelDescriptor

Immutable backend-scoped model or runtime resource.

| Field | Type / rule |
|---|---|
| `modelDescriptorId` | UUID |
| `backendId` | Owning descriptor reference, never connection ID |
| `version` | Positive immutable version |
| `canonicalName` | Provider-neutral owner-visible name |
| `familyProfileId/version` | Exact semantic profile |
| `declaredCapabilities` | Sorted capability IDs, treated as claims until qualified |
| `limits` | Bounded provider-neutral input/output/modalities fields where known |
| `provenance` | Immutable initial discovery source, adapter release, configuration revision, observed time, and probe snapshot |
| `contentHash` | Hash of immutable normalized fields |

Unique: `(model_descriptor_id, version)` and content must remain identical on duplicate insert.
`provenance` records the observation that first created the immutable descriptor. Later discoveries
from other connection revisions are retained in their own probe snapshots and qualifications; they
must neither replace initial descriptor provenance nor create a duplicate descriptor merely because
their connection provenance differs.

## ProbeSnapshot and HealthSnapshot

Immutable Moonshift-owned snapshots derived from one leased set of untrusted probe/discovery
observations. Adapters never assign snapshot/model IDs, content hashes, qualification, or support.

| Field | Type / rule |
|---|---|
| `snapshotId` | UUID |
| `connectionId` / `configurationRevision` / `adapterReleaseId` | Exact target |
| `probeLeaseId` / `fencingToken` | Authority that produced the observation |
| `observedAt` / `validUntil` | Bounded freshness interval |
| `authenticationStatus` | Non-secret status |
| `liveness` | `LIVE`, `UNREACHABLE`, `UNKNOWN` |
| `readiness` | `READY`, `DEGRADED`, `NOT_READY`, `UNKNOWN` |
| `capabilityObservations` | Scoped claimed/observed status and evidence refs |
| `discoveredModels` | Exact descriptor version references |
| `normalizedFailure` | Optional safe failure code; no raw provider error |
| `contentHash` | Integrity hash |

Late snapshots whose revision, lease, or fence is not current are preserved as stale evidence but do
not refresh qualification.

## ConnectionModelQualification

Derived expiring relation for an exact connection and model descriptor version.

| Field | Type / rule |
|---|---|
| `qualificationId` | UUID derived from input evidence identity |
| `connectionId` / `configurationRevision` | Exact connection revision |
| `modelDescriptorId/version` | Exact immutable model reference |
| `familyProfileId/version` | Applied semantic profile |
| `status` | `QUALIFIED`, `INELIGIBLE`, `STALE`, `UNKNOWN` |
| `capabilityStatus` | Required/optional support with evidence references |
| `probeSnapshotId` / `healthSnapshotId` | Exact evidence inputs |
| `conformanceReportId` | Complete report input |
| `reasonCodes` | Sorted stable eligibility/exclusion codes |
| `derivedAt` / `validUntil` | Derivation and expiry |
| `derivationVersion` | Moonshift evaluator version |
| `contentHash` | Hash of complete normalized derivation |

Invariant: `QUALIFIED` requires usable auth, fresh readiness, matching model relation, complete passing
mandatory cases, and every required capability. No adapter writes this entity.

## CapabilityDescriptor and CapabilityObservation

`CapabilityDescriptor` defines a stable namespaced capability, scope (`FAMILY`, `CONNECTION`, `MODEL`,
or `EXECUTION`), value shape, and conformance case mapping. A scoped observation records requirement
`MANDATORY` or `OPTIONAL` separately from status `SUPPORTED`, `UNSUPPORTED`,
`TEMPORARILY_UNAVAILABLE`, `NOT_APPLICABLE`, or `UNKNOWN`, plus source, observed time, and evidence.
Unknown capability IDs evaluate as unsupported for eligibility.

## ExecutionRequirement

Immutable route input for one attempt.

Fields: requirement ID; task/agent identity; allowed exact family profiles; selected or acceptable
model descriptors; mandatory capabilities; context manifest/classification/destination; authority and
budget references; usage dimensions; deadline; runner/cognitive capacity; review diversity; optional
checkpoint and compatibility requirements; governing policy version; creation timestamp and hash.

An adapter cannot broaden any requirement. Multiple allowed families are an explicit policy choice,
not implicit interchangeability.

## RoutingSnapshot and RouteDecision

`RoutingSnapshot` freezes the requirement, policy, candidate qualifications, health, auth, quota,
capacity, and checkpoint compatibility inputs. `RouteDecision` records:

- decision ID, snapshot ID/hash, evaluator version, created time;
- every considered candidate in stable order;
- per-candidate eligibility and sorted exclusion reason codes;
- selected connection/model/adapter/profile or null;
- stable tie-break values and concise non-private rationale code;
- `SELECTED`, `BLOCKED`, or `QUEUED` outcome;
- revalidation inputs and expiry.

Identical snapshot bytes and evaluator version produce the same normalized decision content hash.
History is immutable; re-routing creates a successor decision.

## BackendCommand, BackendEvent, BackendResult, and BackendFailure

Common messages use exact contract version, message/correlation/causation/idempotency identities,
connection/configuration/adapter/profile provenance, execution identity, sequence where applicable,
and timestamps.

- `Probe` / `Discover`: bounded non-secret observation requests.
- `Start`: requirement, model descriptor, context manifest, capabilities, authority, budget, seed and
  deadlines.
- `Cancel`: idempotent requested reason and authority fence.
- `Resume`: successor execution plus checkpoint hash and compatibility evidence.
- `BackendEvent`: monotonic sequence and one closed event-kind-specific payload; there is no generic
  observable or extension map.
- `BackendResult`: exactly one terminal outcome, normalized usage, artifacts/checkpoint refs, and effect
  reconciliation status.
- `BackendFailure`: stable category, retry/reconcile hints, safe summary code, and no raw provider body.

Execution attempt state transitions:

```text
QUEUED → STARTING → RUNNING → SUCCEEDED
                   │       ├→ FAILED
                   │       ├→ CANCEL_REQUESTED → CANCELLED
                   │       │                    ├→ FAILED
                   │       │                    └→ RECONCILING
                   │       ├→ CHECKPOINTING → SUSPENDED
                   │       └→ LOST → RECONCILING
RECONCILING → SUSPENDED | FAILED | CANCELLED
```

Terminal backend results do not by themselves verify a task; Feature 001 evidence policy remains
authoritative.

## UsageRecord

Immutable dimensions for one execution or connection interval.

Fields: usage record ID; execution/connection/model/adapter provenance; dimension ID; quantity as
bounded decimal string; unit; scope; `MEASURED`, `ESTIMATED`, `SYNTHETIC`, or `UNAVAILABLE`; source;
confidence; observation interval; optional quota remaining/reset; optional monetary currency/amount
only when directly evidenced; evidence hash; recorded time.

Different units never add without an explicit versioned conversion rule. Subscription quota is not
monetary API cost. Feature 001 fake usage remains `SYNTHETIC`.

## ExecutionCheckpoint compatibility extension

Feature 001 checkpoint contents remain. Feature 002 adds:

- common contract and family profile versions;
- required capability IDs and scopes;
- accepted event/result sequence and deduplication state;
- context classification and allowed destination;
- model descriptor and connection qualification provenance;
- remaining budgets and compatible usage units;
- pending effect reconciliation requirements;
- artifact/checkpoint hashes and compatibility evaluator version;
- optional opaque session hint reference.

Checkpoint states remain `VALID`, `CORRUPT`, `STALE`, `INCOMPATIBLE`, or `INSUFFICIENT`. Only `VALID`
with a qualified compatible replacement may produce a resume command.

## ConformanceProfile, Case, Run, Report, and SupportClaim

### ConformanceCase

Immutable case ID/version, common/family/capability layer, exact applicability rule, mandatory/optional
classification, input fixture hash, deterministic seed/clock, budgets, expected normalized
observations, forbidden field classes, normalization version, and pass/fail rules. Common cases are
always mandatory; capability cases become mandatory when their capability is claimed.
Each case resets to the corpus clock epoch, derives its seed from the corpus seed plus immutable case
ID/version, and explicitly caps runtime, events, artifacts, usage records, payload bytes, and payload
depth; no case inherits ambient process limits.

### ConformanceRun

Bounded attempt with run ID, adapter/connection/configuration/model target,
profile/corpus/contract/normalization/evaluator versions, lease/fence, start/end/freshness, case states
(`PENDING`, `RUNNING`, `PASSED`, `FAILED`, `NOT_APPLICABLE`, `CANCELLED`, `INCOMPLETE`), and evidence
artifact references.

### ConformanceReport

Integrity-addressed immutable summary of every applicable case, normalized observation hashes,
failure codes, incomplete cases, durations, toolchain/adapter provenance, and corpus/profile versions.

### SupportClaim

Derived status `CONFORMANT`, `NONCONFORMANT`, `STALE`, or `UNKNOWN`, exact adapter release, connection
revision, model relation, family profile and claimed-capability scope, report ID/hash, evaluator
version, derived/expiry time, and reason codes. Complete passing applicable mandatory cases are
necessary. A test-only report can yield only `TEST_FIXTURE_ONLY`, never a real adapter support claim.

## Persistence mapping

Migration `004_execution_backends.sql` adds:

- `backend_descriptors`
- `backend_adapter_releases`
- `backend_connections`
- `backend_model_descriptors`
- `backend_probe_snapshots`
- `backend_health_snapshots`
- `backend_connection_model_qualifications`
- `backend_conformance_reports`
- `backend_route_decisions`
- `backend_usage_records`

Existing `audit_events`, `outbox_events`, `idempotency_records`, `leases`, `aggregates`, and artifact
metadata remain shared infrastructure. Foreign keys preserve history; retirement uses lifecycle state,
not destructive deletion. Conformance case bytes and full reports use artifact references.

## Cross-entity invariants

1. No qualified relation references mismatched backend, profile, connection revision, descriptor
   version, or expired/tampered evidence.
2. No route selects a candidate omitted from its frozen snapshot or carrying any mandatory exclusion.
3. A start succeeds only when route, authority, configuration, qualification, health, budget, capacity,
   and checkpoint inputs still match.
4. Each execution has at most one accepted event per sequence and exactly one accepted terminal result;
   conflicting duplicates fail and trigger reconciliation.
5. A resume creates a successor execution and never changes project, task, or logical agent identity.
6. Usage cannot be aggregated across incompatible units or represented as monetary cost without direct
   evidence.
7. A conformant support claim is impossible from failed, missing, expired, incomplete, unknown-version,
   or integrity-invalid evidence.
8. No credential, provider-private payload, raw transcript, arbitrary path, or private reasoning field
   is accepted by any entity or public projection.
9. Every Feature 002 profile, descriptor, report, and support claim is test-only; every adapter release
   is a fixture, regardless of the semantic family it simulates.
10. Probe and health inputs must match the exact lease, fence, connection revision, adapter release,
    and profile. Late evidence remains historical and cannot refresh current qualification.
