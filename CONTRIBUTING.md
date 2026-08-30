# Contributing to Moonshift

Moonshift is in pre-implementation alpha. Contributions should help establish a small, testable self-hosted system rather than assume that planned integrations or interfaces already exist.

## Before changing the repository

Read the [constitution](.specify/memory/constitution.md), the active feature specification and plan, its `tasks.md`, and any applicable checklists or analysis. The task file is the execution source of truth: respect dependencies, `[P]` markers, and existing checked state. If the relevant Spec Kit artifacts are missing or inconsistent, record that as a documentation task before implementing around it.

Use English for normative project artifacts, source code, and public documentation. Keep the change bounded to the feature or task being addressed, and preserve unrelated local work.

## Development method

GitHub Spec Kit is Moonshift's first development method. The normal lifecycle is constitution alignment, specification, clarification when needed, requirements-quality checks, planning and research, task decomposition, cross-artifact analysis, bounded implementation, deterministic verification, and convergence. Follow the repository's installed Spec Kit integration and active artifacts for the exact commands; this document intentionally does not invent a command line or installation procedure.

Do not begin production implementation before the applicable specification, plan, tasks, and required quality gates are ready. Prefer a deterministic fake backend before real provider or harness integrations. Keep model APIs and coding harnesses as separate backend families, and do not let provider-specific types become domain contracts.

## Pull requests and review

Describe the user-visible or repository-facing behavior, the bounded scope, relevant Spec Kit task IDs, validation performed, and any unresolved decision. Include evidence tied to the relevant revision where the change affects behavior. Security, authorization, persistence, concurrency, runner isolation, public contracts, or other cross-cutting changes require independent review under the constitution.

Do not claim an integration or legal usage mode is supported without current documentation, an explicit compatibility review, and the applicable conformance evidence. Never add credentials or private model reasoning to source, logs, tests, or artifacts.

The open-source license remains a human decision. Until that decision, this file documents the
future contribution workflow but does not invite broad external code intake or grant reuse rights.
See [`docs/decisions/0004-open-source-license-options.md`](docs/decisions/0004-open-source-license-options.md)
for the comparison and interim rule.
