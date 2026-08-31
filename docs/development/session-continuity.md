# Moonshift Session Continuity

Moonshift treats Git-tracked specifications, tasks, code, tests, evidence, and commits as canonical.
Conversations are replaceable execution context: useful for reasoning, but incomplete, mutable, and
unavailable to some future sessions. A contributor must be able to continue from the repository alone.

## Starting or resuming work

Resume the existing conversation when continuing the same atomic line of work and its context remains
useful. Start a fresh conversation when a clean context reduces confusion; it must read the effective
`AGENTS.md`, `docs/development/current-work.md`, the constitution, every active feature artifact, task
checkboxes, and recorded test evidence before editing. Compact a long conversation after durable state
has been written. Use a fork or side conversation for a bounded alternative, read-only investigation,
or independent review, and use a subagent only with exact scope, files, and expected evidence.

The parent session owns architecture, integration, task checkboxes, checkpoint status, final
validation, convergence, current-work updates, and commits. Results from another context are not
durable until the parent incorporates them into tracked artifacts or commits.

## Avoiding concurrent conflicts

Before editing, inspect the branch, `HEAD`, status, applicable instructions, task boundary, and first
incomplete task. Preserve existing changes and never reset or clean them away. Parallel writers must
own disjoint files. If their work overlaps or changes shared architecture, create separate Git
worktrees from an agreed commit, validate each branch independently, then integrate deliberately in
dependency order. Re-run shared checks after integration; passing in an isolated worktree is not
evidence that the combined branch passes.

## Leaving a checkpoint

Complete one atomic edit or task batch when safe, run the narrowest relevant deterministic checks,
and update `docs/development/current-work.md`. Mark a task in `tasks.md` only when its deliverable and
required evidence exist. Record a failed attempt, exact error, affected files, and next diagnostic in
current-work without checking the task. At a valid phase checkpoint, run the full required suite,
review the complete diff, converge, obtain required independent review, update the handoff, and create
a scoped local commit. Do not push automatically.

If context is exhausted, a tool fails, or the session is interrupted, finish or safely roll back only
the current atomic edit, stop background processes, record dirty files and test outcomes, identify the
first incomplete task, and provide the exact next command. Never rely on a process, terminal buffer,
temporary session ID, or uncommitted hidden state that a fresh session cannot discover.

Never launch `codex`, `codex exec`, `codex resume`, or `codex fork` recursively from a command issued
inside Codex. The human or host surface chooses sessions.

## Operator reference

These are contributor tools, not Moonshift application requirements:

```bash
# Resume a recent interactive conversation for this repository
cd /Users/gabin/dev/moonshift
codex resume --last

# Open the interactive session picker
codex resume

# Fork the most recent interactive conversation into a new chat
codex fork --last

# Resume the most recent non-interactive execution
codex exec resume --last "Read AGENTS.md and continue the active Moonshift checkpoint from repository state."
```

Useful interactive controls when the installed Codex surface supports them:

```text
/compact  summarize older context in a long chat
/side     perform a short isolated investigation and return
/fork     branch the current chat while preserving the original
/new      start a fresh chat in the same CLI process
/resume   select and reopen a saved chat
/review   review current changes
```
