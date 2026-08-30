# Routing and Checkpoints

Routing assigns a cognitive resource to a runtime; it never changes the logical agent identity. A
checkpoint makes the logical task portable across compatible backend instances and recoverable after
process or runner loss.

## Routing inputs

The router evaluates:

- required capabilities and task type;
- data classification, privacy restriction, external destination, and allowed provider families;
- model and harness family diversity requirements;
- context/input size, output form, tool, schema, and resume needs;
- connection health, version conformance, rate limits, and auth expiry;
- subscription lease availability, quota health, and API budget;
- measured latency, quality, and reliability history;
- global cognitive and runner capacity;
- independent-review lineage and diversity policy.

The route decision records all candidate exclusions and a concise selection rationale. It never stores
private model reasoning.

## Strategies

Supported policy strategies are manually pinned, best available, subscription first, cheapest
acceptable API, maximum quality, local only, privacy constrained, latency constrained, diverse
independent review, and fallback on quota, outage, auth expiry, or conformance failure. A strategy is
a policy input, not a provider-specific code path.

Default global cognitive concurrency is three. The v0.1 ceiling is five after validation. Each
personal subscription connection has one active lease by default. Queue state must distinguish
backend quota from global capacity and runner capacity.

## Checkpoint contents

A provider-neutral `ExecutionCheckpoint` contains at least:

- project, task, identity, delegation, and runtime identifiers;
- objective, acceptance criteria, and current durable state;
- decisions and concise rationale summaries;
- open questions and remaining work;
- repository location, revision, worktree, and diff status;
- relevant artifacts, evidence, tool results, and failed checks;
- context manifest and classification constraints;
- granted tools, budget consumed/remaining, and lease state;
- requested or applied external effects with reconciliation status;
- optional provider conversation or harness session hints;
- checkpoint version, hash, creator, and creation reason.

Provider session hints are encrypted references when sensitive and may be discarded without losing
canonical work state.

## Checkpoint-and-switch sequence

1. Stop or detect loss of the current runtime and block new effects for its fencing token.
2. Persist the latest known events and create a versioned checkpoint.
3. Reconcile every in-flight external effect against physical ground truth.
4. Recompile context from current authoritative state; do not forward the old raw transcript.
5. Route to a compatible conformant backend and issue fresh tool and budget leases.
6. Resume the same identity and task from remaining work.
7. Record the backend change, capability delta, context destination, and reconciliation outcome.

If a required capability cannot be preserved, the task becomes `BLOCKED` with an actionable reason;
the router must not silently weaken evidence or security requirements.

## Failure policy

Transient normalized failures may be retried within an idempotent attempt budget. Authentication,
policy, unsupported-capability, and deterministic input failures are not blind retries. Cancellation
must revoke tool leases promptly, checkpoint safe state, and reconcile uncertain effects before a new
runtime starts.
