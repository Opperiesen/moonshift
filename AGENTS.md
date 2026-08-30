# Repository working rules

These rules apply to work in the Moonshift repository.

## Scope and status

- Use **Moonshift** as the project, repository, executable, and CLI name.
- Write normative repository artifacts and public documentation in English.
- Treat this repository as pre-implementation alpha. Do not describe planned behavior as shipped or supported without implementation and conformance evidence.
- Preserve the product identity: self-hosted, one human supervisor per instance, provider-agnostic, and able to support distinct model API and coding-harness backends.
- Keep the control plane, execution runner, and CLI boundaries explicit. Do not introduce a managed SaaS dependency as a requirement.

## Spec Kit workflow

GitHub Spec Kit is Moonshift's first development method. Before meaningful implementation, read the applicable constitution, specification, plan, tasks, checklists, and analysis artifacts. Respect their ordering, dependencies, `[P]` markers, and checked task state.

Specifications describe behavior and intent; plans record justified technical decisions; tasks are the execution source of truth. Update task state only after the corresponding work has been validated. Use the installed project workflow and documented commands; do not invent commands or bypass a gate.

After implementation, run the targeted deterministic checks and converge the implementation against its artifacts. Keep changes small, reviewable, and limited to the requested feature.

## Safety and repository hygiene

- Inspect repository instructions and active Spec Kit artifacts before editing.
- Preserve unrelated work and do not overwrite concurrent changes.
- Never commit secrets, cookies, tokens, credentials, private keys, or provider session material.
- Do not use consumer web cookies or subscription sessions as generic API credentials.
- Keep provider and harness types behind Moonshift-owned contracts; never use a provider session as an agent identity.
- Do not weaken meaningful tests, disable security boundaries, or claim support without a conformance path.
- Do not publish, push, deploy, or mutate remote infrastructure unless explicitly requested.
- Validate the smallest relevant scope first, then inspect the final diff and report files changed, checks run, and blockers.

The project constitution at [`.specify/memory/constitution.md`](.specify/memory/constitution.md) is authoritative when these rules or lower-level artifacts conflict.
