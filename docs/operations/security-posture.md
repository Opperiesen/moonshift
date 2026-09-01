# Fixture-only security posture

The current implementation is a controlled local fixture and public alpha. It is not a production
security boundary or supported deployment profile.

Implemented or exercised boundaries include one supervisor model, provider-neutral fake execution,
explicit policy and approval checks, durable audit/idempotency/recovery state, owner-local artifact
hashing, loopback control-plane assumptions, and a separate runner using owner-local TLS 1.3 mutual
authentication. Runner messages are identity- and lease-bound; replayed, revoked, mismatched, or
plaintext traffic is rejected. The fixture profile denies network, arbitrary shell, provider
credentials, and GPU requests, and admits only one bounded fixture job.

These controls do not provide OCI isolation, hostile-workload protection, unrestricted repository
execution, real provider authentication, public-network service hardening, production backup
scheduling, or a general retention/deletion policy. No such support should be inferred until a later
slice supplies implementation and conformance evidence.

When evaluating locally:

- keep PostgreSQL and any local service bound to loopback;
- use only `fixtures/supervised-loop-repository/`, which is versioned and deterministic;
- never place credentials, cookies, tokens, private keys, or private reasoning in fixtures, logs,
  artifacts, manifests, or bug reports;
- treat `.env.example` as fixture defaults, not a deployment secret store;
- report suspected vulnerabilities privately according to [`SECURITY.md`](../../SECURITY.md).

Security tests and the active feature checklists are the authority for what has been demonstrated.
Design intent, documentation, and an acceptance scenario are not evidence of production readiness.
