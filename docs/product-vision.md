# Moonshift Product Vision

**Status:** Normative product foundation. This document states product intent and boundaries; it does not prescribe implementation architecture. The constitution at [`../.specify/memory/constitution.md`](../.specify/memory/constitution.md) has higher authority.

## Identity

Moonshift is an open-source, self-hosted, provider-agnostic workspace where autonomous software agents organize, build, review, and verify software under the supervision of one human.

Its short description is **self-hosted autonomous software development**. Moonshift is an autonomous software-development organization with a browser collaboration surface and supervisor-oriented control plane. It is not a chatbot, a fixed workflow, a thin UI over one agent framework, or a wrapper around one model provider.

The system is AGI-oriented in the systems sense: useful intelligence emerges from persistent identities, interchangeable models and coding harnesses, dynamic organization, tools, isolated execution, compiled context and memory, specifications, independent review, objective evidence, evaluation, and human sovereignty. No model, provider, SDK, CLI, or framework is Moonshift's intelligence.

## Product promise

The supervisor gives Moonshift a software objective and optionally an existing Git repository. Moonshift creates the smallest suitable organization of persistent personas and temporary specialists, structures and specifies the work, delegates implementation and review, executes in isolated runners, verifies completion through objective evidence, and returns a branch or pull request with code, tests, specifications, artifacts, and an auditable history.

The final result is a verifiable software change, not an agent message claiming completion. See the [glossary](glossary.md) for the domain vocabulary and the [feature map](feature-map.md) for staged delivery.

## Human and organization model

Each v0.1 self-hosted instance serves exactly one human supervisor. The supervisor defines objectives, observes the organization, sets policy and budgets, approves sensitive actions, and can pause, resume, cancel, stop, revoke, approve, or reject work. There are no team accounts, invitations, social graph, voice/video chat, or multi-human RBAC in v0.1.

Projects use a default council of three persistent personas: Product owns intent, requirements, acceptance criteria, and specification; Engineering owns planning, architecture, implementation, and integration; Quality independently owns review, testing, security checks, evidence quality, and verification. Optional personas are created only when justified.

Persistent personas have stable responsibility, memory, policies, permissions, performance history, and routing policy. Temporary specialists are task-scoped identities with explicit objectives, outputs, evidence, capabilities, time, and budget. In v0.1, policy defaults are 2–6 personas, 4 active specialists (8 maximum), 2 specialists per persona (3 maximum), and delegation depth 1; specialists cannot create child agents. These are centrally validated policy values, not scattered constants.

## Product surfaces and shipped components

Moonshift is a browser application with four primary surfaces: Projects, Observe, Supervise, and Results. The collaboration surface uses nested project channels, observable messages and events, agent presence, task/dependency views, approvals, risks, and evidence. Chat is an observable collaboration log, never canonical task state or raw prompt context.

Agent presence is a derived, non-authoritative projection with eleven explicit states: `IDLE`,
`QUEUED`, `THINKING_PROVIDER_CALL`, `USING_TOOLS`, `WAITING_FOR_RUNNER`, `WAITING_FOR_AGENT`,
`WAITING_FOR_APPROVAL`, `VERIFYING`, `BLOCKED`, `COMPLETED`, and `FAILED`. “Thinking” means only that
a provider/fake-backend call is in progress; it never exposes or implies access to private reasoning.
The UI shows status text in addition to color and links each non-idle state to its authoritative task,
execution, approval, capacity, or verification record.

The product boundary has three logical components:

1. **Control plane:** web UI, API, durable project/task/organization/policy/approval/audit/verification state, scheduler, and orchestrator.
2. **Runner:** isolated workspaces, Git worktrees, tools, builds, tests, browsers, and artifact collection; it has no authoritative product state.
3. **CLI:** installation and administration (`init`, `up`, `status`, `doctor`, `backup`, `restore`, `upgrade`, and runner administration), not the primary daily UI.

The release direction includes control-plane and runner OCI images, Compose-compatible all-in-one evaluation packaging, split deployment packaging, reproducible CLI installation, checksums, SBOM, upgrade, backup, restore, and rollback documentation. Kubernetes, a desktop/mobile app, managed cloud edition, marketplace, and multi-user social platform are outside v0.1.

## Sovereignty, execution, and evidence

Moonshift owns authoritative state: identities, projects, tasks, policy, approvals, checkpoints, memory, audit, artifacts, evidence, and Git metadata. Providers, harnesses, browser connections, process memory, and runner-local state are replaceable projections or resumability hints.

Model APIs, coding harnesses, and local runtimes are separate [ExecutionBackend](glossary.md#executionbackend) families. Official authentication and current vendor terms govern every adapter; Moonshift must never scrape, proxy, emulate, or repurpose consumer web sessions. Credentials remain isolated to their connection and are not mounted into arbitrary jobs.

The control plane never executes arbitrary repository code. A runner provides bounded capabilities, filesystem/process/network/time limits, and resource discovery. Every material action and external effect is durable, idempotent, auditable, and reconcilable. An agent may only claim completion; deterministic verification promotes work to `VERIFIED` only when revision-bound tests, artifacts, requirement coverage, review, security gates, and configured human approval are present.

## Self-hosting target

The initial reference target is a small 16 GB Proxmox VE host using remote inference and no local GPU. The validated v0.1 envelope is one supervisor, one primary project, three default personas, four default active specialists, three concurrent cognitive executions (five as the ceiling), and one standard runner job (two only when discovered capacity permits). CPU, memory, process, disk, and optional GPU capacity must be discovered and enforced.

## Delivery principles

Moonshift is delivered as independently demonstrable vertical slices. Spec Kit is the first [DevelopmentMethod](glossary.md#developmentmethod), while the domain preserves a replaceable boundary. Normative specifications and plans remain versioned in Git; the UI projects their status but does not replace them. Self-improvement can propose versioned changes and evaluation, but cannot silently change the constitution or promote itself.

The staged roadmap is maintained once, in [`feature-map.md`](feature-map.md). Human choices still required before public release are maintained once, in [`open-decisions.md`](open-decisions.md), including the license and final technology choices.
