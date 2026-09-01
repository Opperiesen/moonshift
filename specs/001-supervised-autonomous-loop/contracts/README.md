# Feature Contract Set

These versioned planning contracts define the independently testable boundaries for the supervised
autonomous loop. They are implementation inputs, not evidence that an API or runtime already ships.

| Contract | Purpose |
|---|---|
| [http-api.openapi.yaml](http-api.openapi.yaml) | Loopback supervisor command/query and SSE surface |
| [event-envelope.schema.json](event-envelope.schema.json) | Durable project-sequenced event envelope |
| [execution-backend.schema.json](execution-backend.schema.json) | Minimum provider-neutral fake-backend command/event boundary for slice 001 |
| [runner-protocol.schema.json](runner-protocol.schema.json) | Authenticated fixture-runner registration, resource discovery, lease, execution, and reconciliation messages |
| [fake-backend.md](fake-backend.md) | Deterministic scenario, checkpoint, artifact, and conformance behavior |

## Contract rules

- JSON Schema files use Draft 2020-12 and reject unspecified top-level properties.
- Every message carries a schema version and stable Moonshift-generated identifiers.
- HTTP mutation commands require an idempotency key and correlation ID.
- Event delivery is at least once; `eventId` deduplicates and `sequence` orders within a Project.
- Provider and framework request/session types cannot cross these contracts.
- Adding optional fields is compatible within `1.x` only when readers ignore them inside documented
  extension objects. Removing, renaming, changing meaning, or making an optional field required needs a
  new contract major and migration plan.
- Examples become contract fixtures during implementation and MUST validate against these files.
- Generated TypeScript output is derived and reproducible; the schemas here remain the source of truth.

Slice 001 proves only the smallest deterministic fake boundary needed by the walking skeleton: stable
backend, connection, backend-scoped model-descriptor, per-connection descriptor-availability,
execution, and optional session identities; strict commands;
normalized events; checkpoints; cancellation; and two interchangeable fake connections. Slice 002
generalizes capability discovery, conformance, health, usage, routing, and checkpoint behavior across
real backend families. Passing the slice 001 fake contract is not a claim of provider support.

## Runner transport authentication

Runner JSON Schema validation does not authenticate a message. Slice 001 uses a dedicated TLS 1.3
listener bound to loopback and mutually authenticated with an owner-local per-instance CA. Setup
creates one fixture-runner server certificate and one control-plane client certificate in an
owner-only directory (`0700` directory, `0600` private keys); private key bytes never enter protocol
messages, logs, events, artifacts, or evidence. The daemon opens TLS files without following final
symlinks, verifies effective-UID ownership and permissions on the opened descriptors, rejects
replaceable directory ancestry, and keeps the validated directory inode pinned until a post-read
identity check succeeds. The runner daemon accepts commands only from an explicitly enrolled
control-plane client certificate whose instance URI matches `instanceId`; a runner-role certificate
can never issue a lease or command. The control-plane client validates the runner server certificate
and requires its runner URI identity to match every message's `runnerId`.

Every lease, command, result, heartbeat, and registration is accepted only in its authenticated
direction on that stream. Receivers persist processed `messageId` values, bind results to `operationMessageId`,
`executionId`, `leaseId`, and the current fencing token, and reject identity mismatch, plaintext
transport, replay, expired certificate, unknown issuer, or revoked certificate serial before domain
handling. Revocation marks the Runner disabled, closes its streams, fences its leases, and requires a
new certificate and explicit re-enrollment; it also aborts and awaits active fixture jobs before the
daemon closes so revoked work cannot publish a result or mutate the ledger. Revocation never revives
old authority. Split/non-loopback enrollment and certificate rotation UX remain slice 006 work, but
unauthenticated runner transport is not permitted in this slice.

Runner-protocol fencing tokens are positive JSON safe integers (`1..9007199254740991`). PostgreSQL
stores them as `bigint`, enforces the same ceiling, and fails closed instead of allocating a token that
the JSON boundary could not represent exactly.

Accepted fixture lease offers and their monotonically increasing execution fences are committed to
the same durable runner snapshot as their processed message IDs. Restart reconstructs both current
lease authority and the highest fence per execution, so a superseded fence cannot regain authority
through a new message ID. A cancellation received before its lease offer is durably retained as the
highest revoked authority for that execution; the delayed offer and every same-or-lower fence remain
invalid across restart, while only a strictly higher successor can replace the cancellation fence.
Each offer also carries the PostgreSQL-authoritative `authorizedAt` claim timestamp and both approval
and lease expiries. The authenticated runner validates that the durable claim preceded both expiries;
client and runner host clocks cannot extend or prematurely expire that already-serialized claim.
Certificate revocation atomically marks every persisted runner lease revoked as well as recording the
certificate serial; another enrolled certificate therefore cannot revive pre-revocation authority
after restart. Revocation fences leases, aborts work, and closes the streams before persistence,
durably disables the Runner, and requires explicit enrollment of a new certificate to reactivate it.
A pending-revocation marker preserves that disabled state across restart even if the main snapshot
fails before rename; configured bootstrap enrollments cannot silently reactivate it. Independently,
the daemon durably creates an active-runtime guard before accepting any authority and removes it only
after a proven clean shutdown. Its presence on startup proves that the prior runtime ended
ambiguously, so even rollback of both the main snapshot and an unsynced pending marker remains
fail-closed. On a persistence failure, the live daemon quarantines all authority and stops accepting
connections instead of continuing with an unconfirmed revocation.

The fixture runner journal fsyncs a complete temporary snapshot before atomic rename and fsyncs its
owner-only parent directory before acknowledging the write. A failed pre-rename persistence barrier
cannot advance in-memory replay/effect state or publish a successful result. A failure after rename
makes the live journal durability uncertain and quarantines the daemon until restart reloads and
reconciles the complete on-disk snapshot; the same process cannot retry the effect blindly.

The loopback management stream is the daemon's only network connection and is not exposed to fixture
operations. `networkMode: DENY` describes the leased job/fixture capability: the operation receives no
socket, URL, DNS, or external egress capability, while the authenticated daemon may return its bounded
result on the already established management stream.

## Observable projection sanitization

Backend output is untrusted input. Before any backend observation can become authoritative state,
audit, outbox, SSE, evidence, error detail, or UI data, one deterministic projection sanitizer must:

- construct a new object from the allowlisted schema fields instead of spreading source objects;
- enforce kind-specific schema, field/count/length bounds, normalized reason codes, classification,
  and an exact versioned status/summary vocabulary for this deterministic fake backend;
- reject unknown keys, control characters, absolute or traversal paths, credential-shaped values,
  authorization headers, private-key material, raw prompts/transcripts, and private reasoning fields;
- replace a rejected observation with a safe attributable policy/audit notice while retaining only a
  schema-valid UUID source message ID (otherwise `null`) and a one-way content hash for investigation.

The strict `payload` and `observable` schemas are the only persisted/public forms. Raw backend payloads
are never written to PostgreSQL, logs, artifacts, events, errors, or evidence bundles. Contract and
security tests must reject every prohibited class above, including attempts hidden in nested or
unknown fields and unrecognized free-form summaries containing embedded paths, secrets, or transcript
text. At-least-once delivery is idempotent only when the stable message ID, source hash, execution,
classification, and sanitized projection are identical; divergent reuse of a message ID is rejected
as an idempotency conflict.

## Security classification

All contracts are secret-free. Credential material, raw provider tokens, private chain-of-thought,
raw transcripts, host-sensitive or arbitrary filesystem paths, and unbounded command strings are
prohibited. Opaque credential references are allowed only in later connection contracts; the fake
connection uses `NONE_FIXTURE`. Runner TLS certificate identifiers may be recorded for authentication
and revocation, but certificate private keys are never contract payloads.
