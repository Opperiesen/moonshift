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
creates one control-plane server certificate and one fixture-runner client certificate in an
owner-only directory (`0700` directory, `0600` private keys); private key bytes never enter protocol
messages, logs, events, artifacts, or evidence. The runner validates the control-plane certificate and
instance URI identity. The control plane validates the runner certificate and requires its URI identity
to match both the enrolled `runnerId` and every message's `runnerId`; `instanceId` must likewise match
the authenticated control-plane instance.

Every lease, command, result, heartbeat, and registration is accepted only on that authenticated
stream. Receivers persist processed `messageId` values, bind results to `operationMessageId`,
`executionId`, `leaseId`, and the current fencing token, and reject identity mismatch, plaintext
transport, replay, expired certificate, unknown issuer, or revoked certificate serial before domain
handling. Revocation marks the Runner disabled, closes its streams, fences its leases, and requires a
new certificate and explicit re-enrollment; revocation never revives old authority. Split/non-loopback
enrollment and certificate rotation UX remain slice 006 work, but unauthenticated runner transport is
not permitted in this slice.

The loopback management stream is the daemon's only network connection and is not exposed to fixture
operations. `networkMode: DENY` describes the leased job/fixture capability: the operation receives no
socket, URL, DNS, or external egress capability, while the authenticated daemon may return its bounded
result on the already established management stream.

## Observable projection sanitization

Backend output is untrusted input. Before any backend observation can become authoritative state,
audit, outbox, SSE, evidence, error detail, or UI data, one deterministic projection sanitizer must:

- construct a new object from the allowlisted schema fields instead of spreading source objects;
- enforce kind-specific schema, field/count/length bounds, normalized reason codes, and classification;
- reject unknown keys, control characters, absolute or traversal paths, credential-shaped values,
  authorization headers, private-key material, raw prompts/transcripts, and private reasoning fields;
- replace a rejected observation with a safe attributable policy/audit notice while retaining only its
  source message ID and content hash for investigation.

The strict `payload` and `observable` schemas are the only persisted/public forms. Raw backend payloads
are never written to PostgreSQL, logs, artifacts, events, errors, or evidence bundles. Contract and
security tests must reject every prohibited class above, including attempts hidden in nested or
unknown fields.

## Security classification

All contracts are secret-free. Credential material, raw provider tokens, private chain-of-thought,
raw transcripts, host-sensitive or arbitrary filesystem paths, and unbounded command strings are
prohibited. Opaque credential references are allowed only in later connection contracts; the fake
connection uses `NONE_FIXTURE`. Runner TLS certificate identifiers may be recorded for authentication
and revocation, but certificate private keys are never contract payloads.
