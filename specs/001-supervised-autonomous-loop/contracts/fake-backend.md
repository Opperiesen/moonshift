# Deterministic Fake Backend Contract

The fake backend is the slice 001 minimum `ExecutionBackend` conformance target. It makes no network request,
loads no provider credential, executes no shell command, and does not read arbitrary repository files.
It consumes only the provider-neutral messages in
[execution-backend.schema.json](execution-backend.schema.json) and requests only the fixture operation
allowed by [runner-protocol.schema.json](runner-protocol.schema.json).

## Identity and instances

The acceptance environment registers two connections, `fake-primary` and `fake-secondary`, with
different Moonshift connection IDs and the same adapter/version/capabilities. Neither ID may appear in
a PersonaIdentity or SpecialistIdentity key. Switching instances changes the AgentRuntime and
Execution attempt, not the logical agent or task.

Both connections expose the same backend-scoped, separately identified and versioned fake
`ModelDescriptor` through distinct `ConnectionModelDescriptor` availability/conformance relations.
The selected descriptor ID/version and the independently selected connection ID are recorded on every
start, resume, event, and Execution. Backend, connection, descriptor, relation, execution, runtime,
and optional session identities are never interchangeable. This contract proves only the
deterministic fake minimum; slice 002 owns general backend-family conformance.

## Advertised capabilities

| Capability | Support | Required conformance behavior |
|---|---|---|
| Health/version probe | Supported | Stable adapter version and capability list |
| Structured input/event/result | Supported | Every message validates against the JSON Schema |
| Ordered streaming events | Supported | Strict per-execution sequence starting at one |
| Tool intent | Supported | Only `WRITE_APPROVED_MARKER`; never executes directly |
| Cancellation | Supported | Stops future events at a scripted safe boundary and emits one terminal event |
| Checkpoint | Supported | Provider-neutral checkpoint at every named boundary |
| Resume | Supported | Any conformant fake instance resumes from checkpoint hash |
| Artifact publication | Supported | One deterministic artifact with expected fixture revision/hash |
| Usage | Synthetic only | Deterministic invocation/unit counts; no invented real cost |
| Arbitrary shell/network/provider auth | Unsupported | Probe and runtime both report/reject |

## Determinism

The normalized objective, task ID, fixture revision, scenario, seed, and checkpoint version determine
all observable content. Wall-clock time, process ID, hostname, backend connection ID, and scheduling
order cannot affect artifact bytes or evidence outcome. The injected clock determines timestamps, and
tests compare normalized events after excluding envelope IDs intended to be unique.

Every observation is constructed through the contract's kind-specific bounded allowlist sanitizer.
Unknown or nested source fields, credential-shaped data, authorization/private-key material, absolute
or traversal paths, raw prompts/transcripts, and private reasoning are rejected and replaced by a safe
attributable audit notice. Raw scripted/backend objects are never persisted, logged, or published.

Given identical logical input and seed, an uninterrupted run and a resumed run produce the same:

- semantic event kinds and payloads;
- tool action digest and effect idempotency key;
- artifact bytes, media type, and hash;
- synthetic usage totals;
- claimed-completion and evidence outcome.

## Scripted sequence

1. Emit `STARTED` with the task and logical specialist references.
2. Emit observable `PROGRESS` describing objective analysis without hidden reasoning.
3. Emit `CHECKPOINT` before the tool request.
4. Emit one `TOOL_INTENT` for `WRITE_APPROVED_MARKER` with expected action digest.
5. Wait for the durable policy and approval outcome.
6. If authorized, request the runner operation and checkpoint before/after the effect boundary.
7. Emit one `ARTIFACT` reference bound to the controlled fixture revision.
8. Emit `COMPLETED` as a claim, or the scripted `FAILED`/`CANCELLED` terminal event.

The backend never emits `VERIFIED`; verification is outside the backend boundary.

## Scenarios

| Scenario | Behavior |
|---|---|
| `PASS` | Approval accepted, effect applied exactly once, passing artifact/evidence fixture |
| `EVIDENCE_FAIL` | Same execution path but deliberately failing evidence marker; task cannot verify |
| `APPROVAL_REJECT` | Approval rejected; no effect or artifact that claims successful completion |
| `INTERRUPT_BEFORE_EFFECT` | Runtime lost after durable intent and before runner mutation |
| `INTERRUPT_DURING_EFFECT` | Runtime lost while result is unknown; reconciliation queries ledger |
| `INTERRUPT_AFTER_EFFECT` | Fixture mutation exists but success event/result was not recorded |

Interrupt scenarios must be executable at each durable sub-boundary by a test-controlled fault signal,
not probabilistic timing.

## Checkpoint rules

The checkpoint contains every field required by FR-027 plus a fake script cursor, seed, normalized
usage, and expected next event sequence. One canonical snapshot determines both its content hash and
derived ID. Resume rejects a corrupt hash/ID, unsupported schema version, mismatched
task/agent/revision, invalid cursor/sequence pair, missing artifact, or capability gap. A valid resume
emits only the suffix after the durable cursor: it never repeats tool intent or effect work already
crossed, and a during-effect checkpoint remains `UNKNOWN` pending later reconciliation. The optional
fake session hint may be dropped without changing the outcome.

## Failure normalization

The adapter maps scripted faults to Moonshift-owned categories: `CANCELLED`, `TIMEOUT`,
`CAPABILITY_UNSUPPORTED`, `CHECKPOINT_INVALID`, `TOOL_REJECTED`, `BUDGET_EXHAUSTED`, and
`BACKEND_LOST`. It includes a safe concise message, retryability, and cause correlation but no stack,
credential, or host-sensitive data in browser events.

## Conformance evidence

Before use in acceptance, both instances must pass probe, schema, event ordering, deterministic replay,
cancellation, timeout, budget, tool approval, checkpoint, cross-instance resume, artifact, usage,
credential-absence, audit-provenance, and failure/reconciliation tests. A failing capability removes
the connection from routing eligibility rather than weakening the task requirement.
