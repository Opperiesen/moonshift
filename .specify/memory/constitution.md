<!--
Sync Impact Report
- Version change: 1.0.0 -> 1.0.1
- Amended principles: none.
- Clarified sections:
  - Development Workflow and Quality Gates now orders planning before reviewer-owned checklists,
    matching the installed Spec Kit 1.0.1 checklist prerequisite without changing any gate.
- Added or removed sections: none.
- Template propagation: no template changes required; feature artifacts already use the clarified
  installed order.
- Follow-up TODOs: none.
-->

# Moonshift Constitution

## Core Principles

### I. Human Sovereignty

Exactly one human supervisor is the root authority for each v0.1 instance. The supervisor MUST be
able to inspect, pause, resume, stop, revoke, approve, and reject work within the limits of safe
recovery. No agent, persona, specialist, runtime, backend, or policy may override the supervisor,
self-approve a sensitive action, or make an irreversible authority change. The product MUST expose
the state and consequences needed for informed intervention without exposing private model
chain-of-thought.

### II. Identity Is Independent from Execution

A persona or specialist identity MUST consist of a stable role, responsibility, policy, permission,
memory, evaluation history, and routing policy. It MUST NOT be identified by a model, provider,
provider account, SDK object, process, session, container, or conversation ID. Runtime selection and
replacement MUST preserve the logical identity, project, task, authoritative history, artifacts, and
evidence.

### III. Moonshift Owns Authoritative State

Canonical project, task, organization, policy, approval, checkpoint, memory, audit, artifact, and
verification state MUST reside on infrastructure controlled by the Moonshift owner. Provider and
harness sessions MAY be resumability hints but MUST NOT be the system of record. Live connections,
UI projections, chat history, process memory, and runner-local state MUST be reconstructable from
durable Moonshift state and external ground truth.

### IV. Model APIs and Coding Harnesses Are Distinct

Moonshift MUST model model APIs, agentic coding harnesses, and local runtimes as different execution
backend families with explicit capability contracts. An API request adapter MUST NOT be treated as a
coding harness, and an already-agentic harness MUST NOT be reduced to a model endpoint. Authentication
modes for API keys, subscriptions, workspaces, and enterprise accounts MUST remain distinct.

### V. Backends Are Replaceable and Conformant

Every execution backend MUST sit behind a Moonshift-owned boundary and MUST pass its applicable
conformance suite before being described as supported. Conformance MUST cover capability discovery,
authentication status, translation, streaming where claimed, tool calls, cancellation, timeouts,
failure normalization, checkpoint recovery, artifact collection, usage or quota accounting,
credential isolation, provenance, and reconciliation. A deterministic fake backend MUST precede real
provider integrations.

### VI. Domain Contracts Are Provider-Neutral

Provider request, response, event, error, usage, tool, session, and checkpoint types MUST NOT escape
adapter boundaries. Moonshift MUST own versioned domain contracts for requests, events, results,
errors, capabilities, tools, usage, and checkpoints. Replacing a provider library, SDK, orchestration
framework, gateway, or model family MUST NOT require rewriting projects, identities, tasks, memory,
or evidence.

### VII. Completion Requires Evidence

An agent claim MUST transition work at most to `CLAIMED_COMPLETE`. Only a deterministic verification
policy may transition a task to `VERIFIED`, and only after every required item is present: revision-
bound tests and artifacts, requirement coverage, independent review where required, security gates,
unresolved-finding policy, and explicit human approval where configured. `Done` is computed from
evidence; it is never inferred from confidence, prose, or lineage.

### VIII. Physical Systems Are Ground Truth

Git revisions and diffs, test outputs, reproducible artifacts, databases, build systems, and external
service state are authoritative for material claims. Messages provide observable collaboration but
MUST NOT replace specifications, decision records, durable task state, commits, evidence, or release
artifacts. Recovery MUST reconcile against the relevant physical system instead of trusting an
interrupted model response.

### IX. Autonomy Is Bounded

Every delegation and execution MUST be limited by policy, capabilities, budget, time, depth, and
discovered capacity. A specialist MUST receive a subset of its parent persona's authority and MUST
NOT create children in v0.1. Defaults and ceilings for personas, specialists, channels, cognitive
executions, runner jobs, nesting, and delegation depth MUST be centrally validated policy values,
not scattered constants. No agent may increase its own permissions, budget, limits, or review
standing.

### X. Quality Is Organizationally Independent

Quality review MUST be performed by a separate logical reviewer outside the authoring Engineering
lineage. A specialist or persona MUST NOT count as the independent reviewer of its own work or parent
lineage. Critical architecture, security, migration, and release decisions MUST support policy that
also requires backend-family or model-family diversity when a conformant alternative is available.

### XI. Least Privilege and Plane Separation

The control plane MUST NOT execute arbitrary repository code. Untrusted repository and generated
code MUST execute through a resource-bounded runner boundary with explicit tool, filesystem, process,
network, and time capabilities. Provider credentials and coding-harness credential homes MUST NOT be
mounted into arbitrary job containers. All-in-one mode MUST be labeled as weaker isolation and MUST
NOT redefine the production security boundary.

### XII. Material Actions Are Auditable

Every material action, policy decision, approval, tool invocation, external transfer, backend
selection, context disclosure, artifact publication, and state transition MUST produce an
attributable, ordered audit event with actor, target, time, reason, outcome, and relevant identities.
Audit records MUST expose observable inputs, outputs, decisions, concise rationale, and provenance;
they MUST NOT store or request private chain-of-thought.

### XIII. Effects Are Durable and Reconciled

Every externally visible effect MUST have a stable idempotency identity, durable intent, explicit
lifecycle, and reconciliation procedure. Leases that can race MUST use fencing. Crashes before,
during, and after an effect MUST be testable, and recovery MUST distinguish applied, failed, unknown,
and reconciled outcomes without duplicating the effect.

### XIV. Context Is Compiled and Minimized

Every cognitive execution MUST receive a provider-neutral context package compiled from the least
data needed for its objective, permissions, and classification rules. Visible chat history MUST NOT
be forwarded wholesale or treated as canonical task state. A `ContextManifest` MUST record selected
inputs, reasons, provenance, hashes, classifications, and external destinations. Memory proposals
MUST be attributable and reviewable.

### XV. Official Authentication and Terms

Moonshift MUST use documented vendor CLI, SDK, OAuth, API-key, workspace, or enterprise mechanisms.
It MUST NOT ask for, scrape, proxy, emulate, export, or repurpose consumer web cookies or personal
subscription sessions as generic API credentials. Each adapter mode MUST have a dated compatibility
and terms review before default enablement. Ambiguous or prohibited modes MUST be marked unsupported,
disabled by policy, or experimental requiring human review; Moonshift MUST NOT bypass restrictions.

### XVI. Self-Hosting and Data Sovereignty

Moonshift MUST remain operable as open-source self-hosted software without a mandatory external SaaS
control plane. The owner MUST retain control of canonical state, identity, policy, audit, memory,
secrets references, checkpoints, artifacts, and Git metadata. Remote inference MAY be used only
through explicit connections and auditable context transfers subject to data-classification policy.

### XVII. Reproducible and Reversible Releases

Public releases MUST be traceable to versioned source and include reproducible installation inputs,
checksums, an SBOM, provenance, release notes, compatibility expectations, and documented upgrade,
backup, restore, rollback, and migration paths. Semantic versioning MUST be used; `0.x` denotes alpha
contracts until deliberate stabilization. A license MUST NOT be selected without the recorded human
decision required before the first public release.

### XVIII. Incremental Vertical Delivery

Work MUST be divided into independently demonstrable, testable vertical slices that exercise real
domain boundaries and objective evidence. Speculative infrastructure, premature distribution, and
framework-driven domain design MUST be rejected. Each slice MUST have explicit exclusions, measurable
acceptance criteria, deterministic validation, and a bounded next increment.

### XIX. Agent Behavior Is Versioned

Persona definitions, specialist roles, prompts, policies, capability grants, routing rules, and
evaluation suites MUST be reviewable versioned artifacts. A runtime MUST record which versions
governed an execution. Behavioral changes that could alter authority, evidence, privacy, or quality
MUST be reviewed and evaluated like code changes.

### XX. Self-Improvement Is Governed

Organizational learning MAY produce attributed proposals for new roles, policies, prompts, routing,
or memory, but MUST NOT silently mutate the constitution or promote itself. Promotion MUST require a
versioned proposal, bounded evaluation, comparison against existing behavior, policy checks, rollback
path, and human approval appropriate to impact. Autonomous constitutional self-modification is
prohibited.

## Product and Operational Constraints

- Moonshift v0.1 MUST serve one human supervisor per self-hosted instance and MUST exclude team
  accounts, invitations, social features, and multi-human role-based access control.
- The shipped product boundary MUST remain a browser control plane, isolated runner, and
  administration CLI. A desktop app, mobile-native app, managed cloud edition, marketplace, and
  Kubernetes distribution are outside v0.1.
- The initial reference deployment MUST support a small 16 GB Proxmox VE host with remote inference,
  without requiring a local GPU. Resource ceilings MUST be measured and enforced rather than assumed.
- The default organization MUST use Product, Engineering, and independent Quality personas. v0.1
  policy MUST enforce two to six persistent personas, up to eight active specialists, maximum
  delegation depth one, and explicit channel and execution ceilings documented in the feature plan.
- Spec Kit MUST be Moonshift's first development method, while the domain MUST preserve a replaceable
  `DevelopmentMethod` boundary. Normative specifications and plans remain versioned in Git.
- PostgreSQL MAY be the initial durable system of record only after planning validates it against
  recovery, small-host operations, migration, and testing requirements. Real-time transports remain
  projections regardless of the chosen stack.
- Security analysis MUST cover repository and web prompt injection, malicious dependencies, secret
  access, privilege escalation, cross-project contamination, compromised model output, duplicate
  effects, destructive Git operations, unauthorized egress, approval spoofing, and audit tampering.

## Development Workflow and Quality Gates

Every meaningful feature MUST follow the installed Spec Kit lifecycle at a depth proportionate to
risk: constitution alignment, specification, clarification when material ambiguity exists, technical
research and planning, reviewer-owned requirements-quality checklists, task decomposition,
cross-artifact analysis, bounded implementation, deterministic verification, and convergence. The
lifecycle MUST stop on unresolved constitutional conflicts or critical analysis findings.

Specifications MUST state what and why without locking implementation technology. Plans MUST record
technology research, rejected alternatives, security boundaries, data and state models, contracts,
resource assumptions, migration and recovery expectations, and test strategy. Tasks MUST be ordered,
path-specific, independently verifiable, and mapped to user stories and evidence. Production code
MUST NOT begin until the active specification, plan, tasks, and required checklists pass their gates.

Changes MUST preserve unrelated user work and use the smallest coherent architecture. Deterministic
checks MUST be discovered from repository conventions, run after meaningful edits, and repaired rather
than bypassed. Critical changes require an independent reviewer. Exceptions to a constitutional rule
MUST be documented with rationale, risk, mitigation, accountable owner, expiry, and explicit human
approval before dependent work proceeds.

## Governance

This constitution is the highest normative project artifact. Feature specifications, plans, tasks,
ADRs, source code, and operational practice MUST conform to it. When artifacts conflict, the lower-
authority artifact MUST be corrected; convenience or prior implementation is not an exception.

Amendments require a versioned change that states the motivation, affected principles, compatibility
impact, migration or remediation plan, and approval by the human supervisor. Versioning follows
semantic versioning: MAJOR for incompatible governance changes or removed/redefined principles, MINOR
for new principles or materially expanded obligations, and PATCH for non-semantic clarification.

Each feature plan MUST complete a pre-design and post-design constitution check. Each cross-artifact
analysis and final review MUST report constitutional conflicts as critical. Compliance MUST be
reviewed before implementation and again before release. Temporary exceptions use the explicit
exception record required above and MUST expire or be renewed by the supervisor; they do not amend
this constitution.

**Version**: 1.0.1 | **Ratified**: 2026-08-30 | **Last Amended**: 2026-08-31
