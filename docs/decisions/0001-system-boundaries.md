# ADR 0001: Establish the Moonshift System Boundaries

- **Status**: Accepted
- **Date**: 2026-08-30
- **Decision owners**: Founding architecture; human supervisor governs amendments
- **Supersedes**: None

## Context

Moonshift must remain a self-hosted autonomous software-development organization, not a chat client,
single-provider wrapper, or framework-specific workflow. It needs durable supervision, isolated code
execution, provider-neutral cognition, and reproducible administration while remaining operable on a
small Proxmox VE host.

## Decision

Moonshift has three logical product components:

1. **Control Plane** owns the browser UI, API, orchestration, policies, approvals, audit, durable
   domain state, scheduling, verification, and migrations.
2. **Runner** owns isolated, leased execution workspaces, Git worktrees, tool execution, builds,
   tests, browsers, and artifact collection. It owns no authoritative product state.
3. **CLI** owns installation and administration workflows such as init, health, backup, restore,
   upgrade, and runner enrollment. It is not the daily collaboration surface.

External systems include Git remotes, execution providers and harnesses, package registries, artifact
storage implementations, and optional infrastructure APIs. Every interaction crosses a versioned
contract and policy boundary. A future `DevelopmentMethod` interface contains Spec Kit as its first
implementation; it is not a fourth deployment component.

## Consequences

- A monorepo and modular control-plane service are preferred initially, but physical packaging remains
  separate for the control plane and runner.
- Chat, WebSocket/SSE streams, model sessions, and runner processes are projections or ephemeral
  execution state.
- Desktop, mobile-native, managed SaaS, marketplace, Kubernetes, and multi-human collaboration are
  excluded from v0.1.
- Cross-boundary contracts and recovery tests are required before optimization or distribution.

## Rejected alternatives

- **Chat-first wrapper**: cannot express durable task, policy, verification, or organization state.
- **One process with unrestricted shell**: violates credential isolation and execution-plane safety.
- **Microservices from the outset**: adds operational cost without a demonstrated scaling need.
- **Framework-owned domain**: would prevent backend and development-method replacement.
