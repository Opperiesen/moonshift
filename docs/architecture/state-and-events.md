# State, Events, and Recovery

Moonshift uses a durable relational system of record, explicit state transitions, an append-only
event history, and an outbox-compatible publication path. Real-time browser delivery is a projection;
disconnecting every browser must not affect execution or authority.

## State machines

### Task

```text
PROPOSED -> READY -> QUEUED -> RUNNING
                           -> WAITING_FOR_AGENT
                           -> WAITING_FOR_CAPACITY
                           -> WAITING_FOR_APPROVAL
                           -> BLOCKED
RUNNING -> CLAIMED_COMPLETE -> VERIFYING -> VERIFIED
Any nonterminal state -> FAILED | CANCELLED (subject to transition policy)
```

Only the Verification Engine may produce `VERIFIED`. A failed verification returns the task to a
repairable state defined by the failure policy; it cannot silently accept the claim.

### Execution

```text
QUEUED -> STARTING -> RUNNING -> SUCCEEDED
                         |-> WAITING_FOR_APPROVAL
                         |-> CHECKPOINTING
                         |-> SUSPENDED (pause; successor execution on resume)
                         |-> STOPPING -> STOPPED (stop; successor execution on resume)
                         |-> FAILED
                         |-> CANCELLED
                         |-> LOST -> RECONCILING -> terminal or resumed execution
```

At Project level, pause converges through `PAUSING` to `PAUSED` and preserves pending approvals without
allowing their use. Stop converges through `STOPPING` to recoverable `STOPPED`, cancels pending
approvals, revokes/fences execution authority, and reconciles effects. Cancel converges through
`CANCELLING` to terminal `CANCELLED` using the same safe effect boundary. Resume from `PAUSED` or
`STOPPED` mints new leases and creates a successor Execution from the latest valid checkpoint; stale
authority is never revived.

Pause and verification share a serialized safe boundary. Entering `PAUSING` prevents new evaluation
starts. An evaluation already in `EVALUATING` may atomically compare-and-commit while the Project is
still `PAUSING`; the coordinator waits for it. If it cannot finish within the bounded pause grace
boundary, it becomes `STALE` without a Task transition and is freshly evaluated after resume.
`PAUSED` therefore never admits a later `VERIFYING -> VERIFIED` transition. A Task may become
`VERIFIED` while the Project is still `PAUSING`, but Project completion remains deferred until resume.

### Approval

```text
REQUESTED -> APPROVED | REJECTED | EXPIRED | CANCELLED
```

Approval is bound to an immutable action digest, actor, scope, expiry, and expected effect. Any
material change creates a new request.

### External effect

```text
REQUESTED -> EXECUTING -> APPLIED
                       -> FAILED
                       -> UNKNOWN -> RECONCILING -> RECONCILED
```

`RECONCILED` records the discovered ground-truth outcome; it does not imply success.

## Transaction and event rules

- A command validates current state, policy, expected version, lease, and idempotency key.
- Domain state and its event are committed atomically.
- An outbox record publishes the committed event to projection workers and live subscribers.
- Consumers are idempotent and track stable event IDs; delivery is at least once.
- Optimistic versions prevent lost updates. Runner and scheduler leases use fencing tokens.
- Audit events are append-only; corrections reference the original rather than rewriting history.
- Untrusted backend observations pass a kind-specific bounded sanitizer before any state, event, log,
  evidence, error, or UI projection; raw source objects are never persisted.

## Idempotent effects

Every effect has a stable key derived from the project, task, semantic operation, and intended target,
not an execution attempt. Repeating the command returns the existing effect. The executor persists
intent before action and result after action. If the process dies between them, reconciliation queries
Git, the filesystem, build system, database, or infrastructure API before any retry.

The first slice simulates a sensitive effect but implements the real state, approval, idempotency, and
restart behavior.

## Runtime presence

Presence is a projection of durable and leased state: idle identity, queued, thinking/provider call,
using tools, waiting for runner capacity, waiting for another agent, waiting for approval, verifying,
blocked, completed, or failed. Each projection names its authoritative bounded source record and
observable activity. It is included in the reloadable project query and is never inferred solely from
an open socket, provider stream, or retained SSE window.

## Recovery objectives for the first slice

- Control-plane restart preserves all committed project, task, channel, identity, approval, effect,
  artifact, evidence, checkpoint, and audit state.
- A lost runtime is marked and reconciled without duplicating its effect.
- Replaying events rebuilds the browser projection deterministically.
- Backend instance switch preserves the logical task and agent identity.
- Backup and restore expectations are tested before public release; the first slice establishes schema
  migration and fixture-level restore contracts.
