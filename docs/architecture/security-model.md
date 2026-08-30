# Security Model

Moonshift assumes repositories, dependencies, web content, model output, and tool arguments can be
hostile. The supervisor is trusted as root authority; provider and infrastructure systems are trusted
only for their explicitly configured contracts. Self-hosting reduces mandatory custody transfers but
does not make external inference private.

## Trust zones

1. **Supervisor browser and administration CLI** — authenticated root control surface.
2. **Control plane** — authoritative state, policy, audit, verification, and secret references; no
   repository code execution.
3. **Credentialed backend process** — narrow access to one provider/harness credential and compiled
   context; no implicit host tools.
4. **Tool gateway** — capability, policy, approval, argument, rate, and audit enforcement.
5. **Runner daemon** — leases and isolates jobs; no authoritative product state.
6. **Uncredentialed job container/workspace** — untrusted repository and generated execution.
7. **External services** — Git, registries, providers, websites, and infrastructure APIs.

Cross-zone requests require authenticated identity, scoped capability, expiry, correlation, and audit.

Slice 001 applies that rule to the separate fixture runner: control plane and runner communicate only
over loopback TLS 1.3 with certificates issued by an owner-local per-instance CA. The authenticated
certificate URI identities must match the protocol `instanceId` and enrolled `runnerId`; unknown,
expired, revoked, replayed, mismatched, or plaintext messages fail before domain handling. Revocation
closes streams and fences every outstanding lease. This evaluation identity is not a provider
credential and does not settle future split-runner enrollment UX.

## Core controls

- Least-privilege capability leases with subset-only delegation.
- Dedicated credential homes; credentials never enter context, logs, artifacts, or job containers.
- Rootless OCI jobs inside a dedicated runner VM for production-oriented use.
- Default-deny or narrow-allowlist network policy with audited exceptions.
- Read-only repository access until a task receives a scoped worktree-write capability.
- Durable approval bound to an immutable effect digest; no self-approval.
- Fenced runner leases and idempotent, reconciled external effects.
- Content classification and context-destination policy before provider transfer.
- Append-only attributable audit and revision-bound evidence.
- Version, health, capability, and terms conformance before backend enablement.
- Deterministic allowlist projection of all untrusted backend observations before persistence, logging,
  audit, SSE, evidence, errors, or UI; raw payloads, transcripts, credentials, host paths, unknown
  fields, and private reasoning are rejected rather than retained.

## Threat model

| Threat | Required mitigation and evidence |
|---|---|
| Repository, issue, documentation, or web prompt injection | Treat content as data; context provenance; instruction hierarchy; capability enforcement; adversarial fixture tests |
| Malicious dependency or lifecycle script | Isolated job; network/process/resource limits; explicit install capability; artifact scanning plan |
| Secret-file access or exfiltration | Credential separation; path and network denial; redaction; canary/negative tests |
| Privilege escalation | Rootless runtime, dropped capabilities, dedicated VM, registration probes, escape-response procedure |
| Cross-project contamination | Project-scoped workspaces, leases, caches, artifact namespaces, and cleanup tests |
| Compromised or unsafe model output | Treat output as untrusted intent; policy/tool validation; approval; independent Quality evidence |
| Duplicate external effect | Stable idempotency key, durable intent, fencing, ground-truth reconciliation |
| Destructive Git operation | Scoped worktree, protected refs, command policy, diff evidence, approval for remote mutation |
| Unauthorized network egress | Deny/allowlist policy, DNS/connection controls where available, auditable destination manifest |
| Approval spoofing or replay | Authenticated supervisor, action digest, nonce, expiry, one-way state transition |
| Audit tampering | Append-only records, transactional event/outbox path, integrity hashes, backup and access controls |
| Provider credential compromise | Opaque references, isolated homes, least scope, health/revocation, no redistribution |
| Forged or replayed runner message | Mutual TLS identity binding, enrollment/revocation, message deduplication, lease/execution/result binding, fencing, negative transport tests |
| Backend data exfiltration through observability | Strict kind schemas, bounded sanitizer projections, credential/path/transcript rejection, no raw-payload persistence |

## Authentication posture

v0.1 serves one supervisor but still requires a deliberate local authentication posture before any
non-loopback exposure. The exact mechanism remains in the
[open-decision register](../open-decisions.md). No external network service is exposed by default in
Iteration 0. Slice 001 uses the one-time loopback bootstrap and host-only HttpOnly session defined by
research R-009 and its HTTP contract; this is an evaluation profile, not the future general
authentication decision. The slice 001 fixture runner already requires the local mutual-TLS identity
above; future production enrollment, rotation, and non-loopback trust policy remain later decisions.

## Approval semantics

Approval is required for actions classified sensitive by policy, including credential use beyond an
existing connection scope, remote writes, deployment changes, protected Git operations, widened
network access, or budget expansion. Approval grants one described action or bounded set; it never
grants a general shell or future changed payload.

## Incident and disclosure posture

The supervisor must be able to revoke a connection, stop scheduling, fence a runner, export audit
evidence, and reconcile uncertain effects. Public vulnerability reporting and response expectations
are documented in the repository [security policy](../../SECURITY.md).
