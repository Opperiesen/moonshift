# Organization Model

Moonshift separates durable organizational identities from ephemeral executions. The normal v0.1
project begins with Product, Engineering, and Quality personas and adds temporary specialists only
for bounded work.

## Supervisor

One human supervisor is the instance root authority. The supervisor defines objectives and policy,
sets budgets and provider connections, grants or rejects sensitive effects, inspects all observable
activity, and may pause, resume, cancel, or stop work. No v0.1 entity can create another human
authority or bypass a supervisor decision.

## Persistent personas

A persona is a durable project-scoped identity with a stable responsibility, policy, permissions,
memory references, evaluation history, and routing policy. It is not a process, model, provider,
session, or container.

| Persona | Default responsibility | Independence rule |
|---|---|---|
| Product | Objective, requirements, acceptance criteria, Spec Kit specification | Protects supervisor intent and scope |
| Engineering | Architecture, planning, implementation, integration, technical delegation | Cannot independently approve its own lineage |
| Quality | Test strategy, review, security, requirement coverage, evidence gates | Separate from authoring Engineering lineage |

Research, Design, Security, and Operations personas may be created only when policy, objective, and
budget justify a durable responsibility.

## Temporary specialists

A specialist is a task-scoped identity created by one persona. It has an objective, expected outputs,
required evidence, allowed capabilities, runtime and budget limits, and explicit termination and
archival conditions. It receives only a subset of its parent's authority. In v0.1 a specialist cannot
spawn children, self-approve, raise limits, or review its own lineage. It may request that its parent
create another specialist.

Archived specialists export artifacts, evidence, decisions, and attributable memory proposals before
their active runtime is removed. Archival preserves audit identity.

## Policy limits

| Dimension | Default | v0.1 validated ceiling |
|---|---:|---:|
| Persistent personas per project | 3 | 6; minimum 2 |
| Active specialists per project | 4 | 8 |
| Active specialists per persona | 2 | 3 |
| Delegation depth | 1 | 1 |
| Active project channels | 24 | 64 |
| Channel nesting depth | Convention-dependent | 4 |
| Direct children per channel | Convention-dependent | 8 |
| Concurrent cognitive executions | 3 | 5 |
| Concurrent standard runner jobs | 1 | 2 when capacity probe permits |

These values belong to a validated policy profile. They are not compile-time constants and cannot be
raised beyond the product ceiling by an agent.

## Delegation contract

Every accepted delegation records:

- parent persona, project, and task identifiers;
- specialist identity and role;
- objective and reason for delegation;
- expected outputs and required evidence;
- allowed tool and data capabilities;
- cumulative active-compute maximum runtime, optional absolute task deadline, invocation/quota budget,
  and measurable monetary budget;
- termination, cancellation, and archival conditions;
- lineage used to enforce independent review.

A delegation is rejected if any grant exceeds the parent, violates project policy, crosses the depth
limit, lacks evidence criteria, or exceeds current organizational or execution capacity.
Maximum runtime counts active compute across attempts and excludes capacity/agent/approval wait.
Task deadline is an absolute scheduling cutoff; short capability/runner/backend lease expiry merely
removes authority. Termination conditions decide stop/failure, while archival conditions run only
after terminal work exports its required artifacts, evidence, decisions, and memory proposals.

## Channels and collaboration

Projects own nested categories and channels. Personas may create, rename, move, and archive them under
policy. Completion normally archives rather than deletes channels so that audit provenance remains.
Messages are observable collaboration events linked to identities and tasks; they are neither raw
prompt context nor canonical state.

The default tree is a convention—general, Product specification/clarification, Engineering
architecture/implementation/integration, Quality testing/review/security, and Release
convergence/evidence—not a fixed workflow.

## Identity and runtime

An `AgentRuntime` binds one logical identity to one selected backend, compiled context, tool lease,
budget lease, and ephemeral process/session. Checkpoint-and-switch replaces that runtime binding
without changing identity, task, history, workspace, artifacts, or lineage.
