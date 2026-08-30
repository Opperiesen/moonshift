# System Context

Moonshift is a self-hosted autonomous software-development organization supervised by one human. It
accepts an objective and optional Git repository, organizes bounded agent identities, executes work
through replaceable cognitive backends and isolated runners, and returns revision-bound evidence. It
is not a model provider, source-code host, chat system of record, or unrestricted remote shell.

## Actors and adjacent systems

| Actor or system | Relationship to Moonshift | Authority |
|---|---|---|
| Human supervisor | Defines objectives, policy, budget, approvals, and stop decisions | Root authority for the instance |
| Git repository / remote | Supplies and receives versioned software state | Physical ground truth for source changes |
| Execution provider or coding harness | Supplies replaceable cognitive execution | No domain or identity authority |
| Runner host | Executes leased tools and untrusted code | Ephemeral execution state only |
| Package registries and research sources | Optional approved network dependencies | External, untrusted inputs |
| Artifact storage implementation | Stores content addressed by Moonshift metadata | Data plane; metadata remains authoritative in Moonshift |
| Infrastructure APIs | Optional future read/write effects under policy | External ground truth after reconciliation |

## Product components

```text
Browser
   |
   v
Control Plane -----> execution API / harness process
   |   |                         |
   |   +-----> PostgreSQL        v
   |                         Tool Gateway
   |                             |
   +-----> Artifact Store        v
                           Isolated Runner Job -----> Git / registries / approved services

Administration CLI -----> Control Plane and local deployment lifecycle
```

The **Control Plane** owns the web experience, API, organization engine, scheduler, policy and
approval services, backend routing, verification, audit, durable state, event log, and projections.

The **Runner** owns isolated workspaces, Git worktrees, bounded tool execution, builds, tests,
browsers, and artifact collection. A runner is replaceable and never authoritative.

The **CLI** owns installation, health diagnostics, backup, restore, upgrade, and runner enrollment.
It is intentionally not the primary daily interface.

See [ADR 0001](../decisions/0001-system-boundaries.md) and
[ADR 0002](../decisions/0002-control-and-execution-plane.md).

## Authoritative flow

1. The supervisor creates a durable project objective.
2. The organization engine creates policy-bounded identities, channels, and tasks.
3. The router leases a conformant execution backend independently of identity.
4. The context compiler emits a minimized provider-neutral package and manifest.
5. A runtime consumes the package and may invoke only leased capabilities.
6. Tool intents and sensitive effects pass policy and, when required, approval.
7. Runner output becomes attributable artifacts and evidence bound to a Git revision.
8. An independent Quality lineage evaluates evidence; only the verification engine can mark work
   `VERIFIED`.
9. The browser observes durable events and projections; it does not manufacture state transitions.

## v0.1 boundary

Included: one supervisor; project and channel hierarchy; personas and specialists; bounded delegation;
provider-neutral backend contracts; isolated runner contracts; durable state, audit, approvals,
checkpoints, effects, evidence, and verification; browser supervision; administration CLI; all-in-one
and split self-hosting plans.

Excluded: multi-human RBAC, invitations, social or media chat, managed SaaS, desktop/mobile-native
clients, Kubernetes, marketplace, recursive specialists, autonomous top-level project creation,
semantic long-term memory, silent self-improvement, and mandatory local GPU inference.

## Ground-truth hierarchy

The constitution governs all artifacts. Versioned specifications and ADRs govern intended behavior.
Moonshift's relational state governs orchestration. Git, tests, artifacts, and affected external
systems govern outcome claims. Chat and provider sessions remain observable evidence sources but are
never canonical task state.
