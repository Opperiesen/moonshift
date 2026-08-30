# ADR 0002: Separate Control and Execution Planes

- **Status**: Accepted
- **Date**: 2026-08-30
- **Decision owners**: Founding architecture; human supervisor governs exceptions
- **Supersedes**: None

## Context

Moonshift processes untrusted repositories and model-generated actions while also holding approvals,
audit history, backend connection metadata, and durable project state. A shared credential and code
execution environment would make repository prompt injection or dependency compromise capable of
reaching the system's root authority.

## Decision

The control plane MUST never execute arbitrary repository code. Runner jobs execute in isolated,
uncredentialed workspaces with explicit CPU, memory, process, disk, time, filesystem, tool, and
network capabilities. A credentialed coding-harness or provider process communicates with the
workspace only through a controlled tool gateway. Subscription credential homes and API secrets do
not enter job containers.

Production-oriented deployment uses a dedicated runner VM as the strong isolation boundary. Rootless
Podman is the first runtime candidate, subject to capability probing. An all-in-one local mode may
co-locate components only when visibly labeled weaker isolation and disabled for untrusted work by
default.

Runner leases use expiration and fencing. Sensitive tool effects are authorized through durable
policy and approval records before execution. Runner loss produces a checkpoint and reconciliation
workflow; it never promotes local state to authority.

## Consequences

- Runner registration must measure resource-control and isolation capabilities.
- Default job networking is deny or a narrow allowlist; dependency and Git access are explicit.
- Tool contracts must work across a process or host boundary from the first vertical slice.
- Local developer convenience cannot erase the production security distinction.
- Threat modeling and crash/idempotency tests are release gates.

## Rejected alternatives

- **Control-plane shell execution**: unacceptable blast radius.
- **Credentials mounted read-only into jobs**: read-only still permits exfiltration.
- **Container-only trust boundary on the PVE host**: insufficient for the production runner target.
- **Per-agent virtual machines in v0.1**: excessive cost for the reference hardware and workload.
