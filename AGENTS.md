# Repository working rules

These rules apply to all work in the Moonshift repository. Moonshift is an open-source, self-hosted,
provider-agnostic autonomous software-development workspace governed by exactly one human supervisor.
Use **Moonshift** as the project, repository, executable, and CLI name. Normative repository artifacts
and public documentation are written in English.

## Authority and bootstrap

For engineering decisions, use this precedence; a lower source never overrides a higher one:

1. explicit instructions in the current user task;
2. [the constitution](.specify/memory/constitution.md);
3. the active feature specification and accepted clarifications, plan, contracts, and tasks;
4. ratified ADRs and architecture documents;
5. tests, schemas, generated validation, and current code behavior;
6. [the current-work handoff](docs/development/current-work.md);
7. conversation transcripts and model recollection.

Chat is replaceable execution context, never authoritative project state. At the start of every fresh
session, inspect the branch, `HEAD`, and worktree; read the constitution, current-work handoff, and all
active feature artifacts; inspect task checkboxes and recorded evidence; identify the first incomplete
in-scope task; and state the bounded scope before editing. Reconstruct state from the repository rather
than asking the user to restate prior conversations.

## Spec Kit and scope

GitHub Spec Kit is Moonshift's first development method. Follow the accepted feature lifecycle and the
active specification, plan, contracts, tasks, checklists, and analysis. Specifications define behavior
and intent, plans record justified technical decisions, and `tasks.md` is authoritative for completion.
Mark a task complete only after its implementation and required deterministic evidence exist. Do not
rerun `$speckit-specify` or `$speckit-plan` unless a real contradiction requires the smallest possible
correction, and never change an accepted requirement merely to fit an implementation.

Implement only the task IDs or phase explicitly assigned by the current prompt. Record later work in
the appropriate feature or open decision without starting it. Feature 001 is complete through T086.
For Feature 002, planning may prepare the complete lifecycle, but production implementation is
prohibited until a separately started implementation checkpoint. The first such checkpoint is
`T001–T035`; `T036+` remains prohibited until the US1 checkpoint is accepted.

## Durable session continuity

All material progress must be durable in Git-tracked files. Follow
[the session continuity protocol](docs/development/session-continuity.md). Before a handoff or
checkpoint, update [current-work.md](docs/development/current-work.md) with the active feature, allowed
range, completed tasks, first incomplete task, branch and commit, worktree state, key files, exact
validation results, unresolved findings, next action, and UTC timestamp. It is a concise navigation
record, not a second task database; task checkboxes remain authoritative. Leave an atomic checkpoint
when practical and record failed attempts without checking incomplete tasks.

Resume an existing conversation for the same line of work when practical; start fresh when clean
context is preferable and reconstruct from Git. Use forks, side conversations, or subagents only for
bounded alternatives, independent review, or isolated investigation. The parent integrates and
verifies results. Parallel writers need disjoint files or isolated Git worktrees, and their results are
not durable until incorporated into repository artifacts or commits. Never launch nested `codex`,
`codex exec`, `codex resume`, or `codex fork` processes from a Codex-generated shell command. When
context grows long, compact or write a durable handoff instead of depending on hidden recollection.

## Engineering and verification

- Treat the repository as pre-implementation alpha; do not describe plans as shipped support.
- Preserve one-supervisor, self-hosted, provider-agnostic, multi-harness product identity and the
  explicit control-plane, runner, and CLI boundaries.
- Use deterministic tests for deterministic behavior and contract-first/test-first work where the
  constitution and active plan require it. Observe intended failures before success implementation.
- Keep changes minimal and task-scoped; do not perform unrelated refactors.
- Keep provider and harness types behind Moonshift-owned adapters and contracts. An agent identity is
  never a provider, model, process, session, container, or conversation.
- Do not claim completion without evidence. Run required independent review, and fail closed for
  ambiguous authorization, verification, external effects, or resource enforcement.
- Run the narrowest relevant checks during work, then the full checkpoint suite, final diff review,
  and `$speckit-converge`. Never weaken a meaningful test to pass a gate.

## Safety, credentials, and Git

- Inspect before modifying and preserve all user or other-agent work.
- Never commit secrets, cookies, tokens, auth caches, credentials, private keys, or provider session
  material. Do not scrape, emulate, proxy, export, or repurpose consumer sessions.
- Features 001 and 002 use no real provider authentication, unrestricted shell, uncontrolled network,
  production deployment, or remote Git effect. Runner and backend fixtures remain capability-minimal.
- Do not use destructive Git operations, rewrite public history, or automatically push, publish,
  release, deploy, or mutate remote infrastructure.
- Do not silently resolve entries in [the decision register](docs/open-decisions.md), select a license,
  or claim support without conformance evidence.
- Keep commits scoped and descriptive. Commit only after the assigned checkpoint passes every
  required validation, then report the resulting hash. Never push automatically.
