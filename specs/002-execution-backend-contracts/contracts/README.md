# Execution Backend Contract Set

These planning contracts define Moonshift-owned Feature 002 boundaries. Checked-in schemas are
normative inputs to implementation and conformance; generated TypeScript is disposable.

| Contract | Purpose |
|---|---|
| `backend-catalog.schema.json` | Family/profile, adapter, connection, model discovery, capability, authentication, and health snapshots |
| `backend-supervision.openapi.yaml` | Initial US1 loopback supervisor queries for qualification evidence; US3 and US4 tasks extend it with route and conformance-report queries |
| `conformance-corpus.schema.json` | Bounded deterministic case manifest, applicability layer, forbidden-field classes, clock, seed, and concurrency |
| `conformance-profile.schema.json` | Common, exact-family, and claimed-capability case ownership plus explicit compatibility |
| `conformance-report.schema.json` | Profile/corpus case outcomes, integrity evidence, and derived support inputs |
| `execution-protocol.schema.json` | Probe/discover/start/cancel/resume commands, ordered events, normalized results, failures, usage, and checkpoint compatibility |
| `routing-decision.schema.json` | Frozen candidate evaluation, exclusions, stable selection, revalidation, and decision provenance |

## Contract rules

- JSON Schema Draft 2020-12 and `2.0` contract envelopes are used for this alpha slice.
- UUIDs are Moonshift identities. Decimal quantities that could exceed safe JSON integers use decimal
  strings. Integrity values use lowercase `sha256:<64 hex>` strings.
- Provider and SDK request/response/error/session types never appear in these contracts.
- `MODEL_API`, `CODING_HARNESS`, and `LOCAL_RUNTIME` are distinct semantic families.
  `DETERMINISTIC_FIXTURE` is test-only and cannot establish a real support claim.
- Unknown family/profile/contract versions and unknown capabilities fail eligibility unless an
  explicit compatible version rule exists.
- Contract `2.0` has no generic extension or observable map. Every accepted observation and event uses
  a Moonshift-owned kind-specific schema. A future extension requires a named schema in the contract
  manifest, an allowlisted semantic owner, explicit size/depth rules, and compatibility fixtures before
  it can cross the adapter boundary.
- Credentials, cookies, raw provider errors, private reasoning, raw transcripts, and arbitrary local
  paths are forbidden.
- Full checkpoint state remains defined by Feature 001's `execution-checkpoint.schema.json`; the
  protocol here carries its integrity reference plus explicit compatibility requirements.
- Supervisor query paths extend the existing loopback `/v1` API on port `4310` and require the same
  `LocalSupervisorSession` cookie; this contract does not define a second server or authentication mode.

## Bounds and authority

- Every JSON object rejects unknown properties. Strings, identifiers, arrays, decimal strings,
  sequences, timestamps, runtime limits, and case counts use the explicit minima/maxima in the
  applicable schema; nested arbitrary JSON is never accepted.
- Boundary readers reject a protocol, catalog, route, report, or profile message above 1,048,576
  UTF-8 bytes or JSON nesting deeper than 16 before schema validation. A corpus manifest is bounded to
  4,194,304 bytes and depth 16. Every event or conformance-case payload is additionally bounded to
  65,536 bytes and depth 16. Framing, byte, and depth failures are stable contract rejections, never
  partially parsed observations.
- A protocol envelope is bounded to one kind-specific payload. Discovery carries at most 1,000 model
  observations; capabilities at most 256; events use a positive 32-bit sequence; a result carries at
  most 64 usage records and 256 artifact IDs; a corpus carries at most 500 cases and 16 workers.
- Probe and discovery results are untrusted observations bound to the envelope's connection,
  configuration revision, adapter release, family profile, lease, and fence. They never carry a
  Moonshift snapshot ID or authoritative support/qualification value. Moonshift alone validates,
  normalizes, assigns snapshot/model identities, hashes, persists, and derives current state.
- Probe and health snapshots must name the same exact connection revision, adapter release, probe
  lease, and fencing token. A late or mismatched result is preserved as stale evidence but cannot
  refresh qualification.
- All Feature 002 descriptors, profiles, reports, and projections are `testOnly = true` with
  `supportScope = TEST_FIXTURE_ONLY`; adapter releases are `FIXTURE`. No valid contract instance can
  assert a real provider, harness, authentication, or local-runtime support claim.

## Capability and conformance semantics

- Capability `requirement` is `MANDATORY` or `OPTIONAL`; observation `status` is independently one of
  `SUPPORTED`, `UNSUPPORTED`, `TEMPORARILY_UNAVAILABLE`, `NOT_APPLICABLE`, or `UNKNOWN`. The values are
  mutually exclusive for one capability, scope, target revision, and evidence time.
- Common cases are always applicable and mandatory. Exact-family cases apply only to the named profile.
  Capability cases are not applicable when the capability is not claimed; once claimed, every case in
  its capability profile is mandatory for support of that exact claimed set. Unsupported optional
  capability, failed claimed capability, and not-applicable case therefore remain distinct.
- Every case resets the deterministic clock to the corpus `clockEpoch`, derives its seed from the
  corpus seed plus immutable case ID/version, and declares complete runtime, event, artifact, usage,
  payload-byte, and payload-depth budgets. A runner cannot silently inherit ambient randomness, time,
  or resource limits.
- A complete run has one terminal result for every applicable case and no `CANCELLED` or `INCOMPLETE`
  case. `PASSED` requires all applicable cases to pass. Support derivation additionally requires exact
  target/profile/corpus/contract/evaluator versions, valid integrity and freshness, the current lease,
  adapter release and connection revision, and `TEST_FIXTURE_ONLY` scope.
- Normalized input/expected/actual hashes exclude only `startedAt`, `finishedAt`, and `durationMs` under
  the named normalization version. Evidence hashes include those observational fields. Count totals,
  applicability, status, and mandatory booleans must reconcile exactly; contradictions fail the report.
- Each prohibited support condition maps to its own stable reason class: failed, missing, expired,
  unknown-version, incomplete/cancelled, integrity-invalid, stale lease/fence, superseded configuration
  or adapter release, profile mismatch, and non-test support scope.

## Compatibility

Within major version 2, an optional field is compatible only when its absence has an explicit default,
its presence cannot change existing required meaning, the reader declares the exact accepted minor
range, and old/new normalization and mandatory conformance fixtures pass both readers. Adding,
removing, or reclassifying a mandatory case; changing applicability, normalized meaning, identity,
hash inputs, authority, privacy, effect, or failure semantics; or changing a field from optional to
required is incompatible and requires a new profile/corpus version and fresh reports. Model descriptor
changes create a new immutable descriptor version; checkpoint reuse additionally requires every named
contract/profile/capability/classification/context/artifact/budget/event/model/effect constraint to
remain satisfied. Compatibility is never inferred solely from a version label, and report reuse is
forbidden unless an integrity-addressed compatibility manifest names every governing version.

## Support boundary

The presence of a contract-valid adapter is insufficient for support. Only a complete, current,
integrity-valid conformance report for the applicable family and capability profiles can derive a
qualified relation. Feature 002 ships deterministic evidence only and makes no real-provider claim.
