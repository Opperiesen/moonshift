# Context and Memory

Moonshift compiles the minimum provider-neutral context needed for one execution. The visible channel
history is not a prompt, and an execution transcript is not long-term memory.

## Context Compiler

The Context Compiler selects from:

- identity role and current responsibility;
- objective, task, acceptance criteria, and delegation contract;
- constitution, active specification, pinned decisions, and relevant policies;
- relevant channel events and task-linked messages;
- approved workspace, project, persona, and channel memory records;
- repository revision, diff summary, and scoped source excerpts;
- artifacts, evidence, tool results, and checkpoint state;
- tool, budget, network, and approval capabilities;
- data classification, retention, and permitted destinations.

Selection uses provenance and explicit relevance reasons. It prefers canonical artifacts over message
summaries and summaries over raw histories. Data that is unnecessary, disallowed for the destination,
or beyond the runtime's task is excluded.

## Context manifest

Every execution stores a `ContextManifest` with:

- manifest version and content hash;
- execution, identity, task, and backend connection references;
- each selected item's stable reference, source revision, hash, classification, and reason;
- transformation or redaction applied;
- estimated size and ordering;
- external destination and applicable retention policy;
- compiler policy version and creation time.

The manifest proves what was disclosed without copying secret or transient content unnecessarily. The
audit UI may show titles, hashes, classification, and rationale while restricting sensitive payloads.

## Memory hierarchy

```text
Workspace memory
└── Project memory
    ├── Persona memory
    ├── Channel memory
    ├── Task context
    └── Artifact and evidence index
```

A `MemoryRecord` has a scope, source, author, evidence references, classification, confidence,
valid-from time, optional expiry, supersession links, and review status. Agent-proposed updates are
proposals until policy or an authorized reviewer accepts them. Conflicts are represented explicitly;
newer does not automatically mean correct.

## Compaction and privacy

Compaction creates attributed summaries linked to their inputs and compiler version. It must preserve
decisions, dissent, open questions, evidence status, and exclusions while removing conversational
noise. Private chain-of-thought is neither requested nor stored. Observable actions, tool requests,
results, decisions, and concise rationale are retained according to policy.

Remote-provider context transfer is an auditable external transfer. Classification policy may require
a local backend, redaction, or supervisor approval. Credentials are never context inputs.

## v0.1 scope

The first slice needs deterministic task context, checkpoint context, provenance, and a context
manifest sufficient to prove backend-instance switching. Semantic retrieval, autonomous memory
promotion, cross-project learning, and self-modifying prompts are excluded. Later work may add them
only behind versioned evaluation and governance.
