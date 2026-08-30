# Spec Kit Development Workflow

Moonshift uses [GitHub Spec Kit](https://github.com/github/spec-kit) as its first development
method. Spec Kit artifacts are durable project state committed with the code; chat and agent sessions
do not replace them. Moonshift's product architecture still treats the development method as a
replaceable boundary.

## Installed baseline

- Specify CLI: `1.0.1`, pinned to Git tag `v1.0.1`
- Default integration: `codex`
- Integration mode: project-local skills under `.agents/skills/`
- Script family: POSIX shell
- Feature numbering: sequential
- Optional extensions: `assess` `1.0.0` and `bug` `1.0.0`
- Last verified against official sources and the installed CLI: 2026-08-31

The reproducible installation command is:

```bash
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.0.1
```

The repository was initialized with:

```bash
specify init --here --force --non-interactive --integration codex
specify extension add assess
specify extension add bug
```

Developers can verify the managed installation without modifying it:

```bash
specify version
specify integration list
specify integration status --json
specify extension list
```

## Feature lifecycle

Use the project-local skills rather than invoking `.specify/scripts/` directly:

1. `$speckit-constitution` establishes or deliberately amends project governance.
2. `$speckit-specify` creates one bounded, independently valuable feature specification.
3. `$speckit-clarify` resolves material product ambiguity before technical commitments.
4. `$speckit-plan` records research, architecture, data, contracts, and validation design.
5. `$speckit-checklist` creates reviewer-owned requirements-quality gates; the installed `1.0.1`
   integration requires `plan.md` before this command can run.
6. `$speckit-tasks` produces dependency-ordered, story-aligned implementation work.
7. `$speckit-analyze` checks constitution, specification, plan, and task consistency.
8. `$speckit-implement` executes a bounded set of tasks with deterministic validation.
9. `$speckit-converge` compares implementation with the durable artifacts and appends gaps.

Substantial or security-sensitive work uses every applicable quality gate. Small, low-risk work may
use a shorter path only when the constitution and repository `AGENTS.md` permit it. A feature is not
complete while convergence identifies missing behavior or evidence.

## Durable state and branches

- `.specify/memory/constitution.md` is the highest-authority project artifact.
- `specs/<number>-<slug>/` is durable feature state. The ignored `.specify/feature.json` is only the
  machine-local selector and is expected to differ between checkouts.
- On a fresh checkout, select an existing feature for a session with
  `SPECIFY_FEATURE_DIRECTORY=specs/<number>-<slug>` before invoking its project-local skills; Spec Kit
  may persist that selection to the ignored local pointer.
- The selected feature directory owns the specification, plan, research, design, checklists, and
  tasks.
- `tasks.md` checkboxes change only after the corresponding work and evidence are validated.
- Custom checklist checkboxes are reviewer-owned requirements-quality judgments, not implementation
  progress.

Do not create parallel `PLAN.md`, `TODO.md`, or roadmap files for state already owned by Spec Kit.

## Optional workflows

Use the assessment extension before specification when a new idea has not passed a product gate. Use
the bug extension for bounded defect assessment, repair, and validation. Neither workflow replaces the
feature lifecycle for architectural product work.

## Updating Spec Kit

An upgrade is a reviewed tooling change. Record the target release and migration notes, preserve local
changes, run integration status before and after, inspect managed-file changes, and update this page.
Never float to an unpinned Git revision in CI or contributor setup.

## Iteration 0 boundary

Iteration 0 ends after the first feature's tasks and consistency analysis. The next bounded phase is
`$speckit-implement` for setup and foundation tasks only, followed by their tests and
`$speckit-converge`.
