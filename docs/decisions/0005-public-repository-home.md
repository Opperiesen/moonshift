# ADR 0005: Publish Moonshift Under the Supervisor's GitHub Account

- **Status**: Accepted
- **Date**: 2026-09-02
- **Decision owner**: Human supervisor
- **Decision gate**: Satisfied before public repository launch

## Context

Moonshift needs one canonical public source repository before it can invite external inspection and
contributions. The earlier decision register deliberately kept the public owner and image namespace
open. Repository publication does not require selecting a container registry or publishing any
artifact.

The current private repository already exists at `github.com/Opperiesen/moonshift`, is administered
by the human supervisor, contains the complete local history intended for publication, and has no
organization governance or additional maintainers to migrate.

## Decision

The canonical public source repository is
[`github.com/Opperiesen/moonshift`](https://github.com/Opperiesen/moonshift). `Opperiesen` remains the
initial owner and administrator.

Before visibility changes, the exact candidate history must pass repository and history secret
scans, deterministic validation, and independent public-readiness review. After visibility changes,
private vulnerability reporting and the available GitHub dependency and secret protections must be
enabled and verified before publication is declared complete.

The repository description, topics, community files, security policy, and Apache-2.0 license must
describe the implemented alpha honestly. No release, package, container image, deployment, or stable
support commitment is created by making the source repository public.

## Consequences

- Public links and package metadata may use `https://github.com/Opperiesen/moonshift`.
- Repository transfer, shared governance, additional maintainers, or organization ownership requires
  a new review of permissions, security controls, automation, and public metadata.
- The OCI registry and image namespace remain unresolved under OD-012. This decision does not
  authorize publishing images or other release artifacts.
- The human supervisor remains the sole authority for repository settings and external effects until
  a later governance decision says otherwise.
