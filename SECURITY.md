# Security policy

Moonshift is an implementation-local alpha. There is no supported production deployment, public
service, or stable release yet. Current security claims apply only to the exact fixture profile and
revision-bound evidence in this repository.

## Reporting a vulnerability

**Do not open a public issue for a suspected vulnerability.** Use GitHub's
[private vulnerability reporting form](https://github.com/Opperiesen/moonshift/security/advisories/new)
so the report and follow-up remain private.

Include only the minimum information needed to assess the issue:

- affected revision, component, or artifact;
- impact and required preconditions;
- reproducible steps or a minimal proof of concept;
- a suggested mitigation, if known.

Remove credentials, personal data, proprietary code, and private model reasoning before submitting.
Do not test systems you do not own or have explicit permission to assess. Acknowledgement and repair
timelines depend on severity and maintainer availability; this alpha does not promise a formal SLA.

## Supported versions

Moonshift has no released version line yet. Security fixes target the current `main` branch. Older
commits, feature branches, fixture artifacts, and downstream deployments are not supported versions.

## Current security boundary

The implemented fixture path includes:

- a separate control-plane and runner process boundary;
- owner-local TLS 1.3 mutual authentication with identity binding;
- replay, revocation, stale-lease, plaintext, and identity-mismatch rejection;
- provider-neutral allowlist projection before backend observations reach persistence or the UI;
- bounded policy, approval, audit, idempotency, fencing, artifact-integrity, and recovery checks;
- denied external network, arbitrary shell, deployment, and provider credentials.

These controls do **not** claim OCI isolation, hostile-workload protection, real provider
authentication, unrestricted repository execution, public-network hardening, production backup
scheduling, or general retention/deletion. See the
[security posture](docs/operations/security-posture.md) and
[security model](docs/architecture/security-model.md) for the exact boundary.

Security-sensitive changes require targeted deterministic validation and independent review. Please
also follow the repository's [responsible contribution guidance](CONTRIBUTING.md).
