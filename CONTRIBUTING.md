# Contributing to Moonshift

Moonshift is an early alpha with a working deterministic foundation and an intentionally staged
roadmap. Contributions are welcome when they preserve its one-supervisor, self-hosted,
provider-agnostic, evidence-driven design.

## Start here

Before changing the repository, read:

1. the [constitution](.specify/memory/constitution.md);
2. the [current work handoff](docs/development/current-work.md);
3. the active feature's `spec.md`, `plan.md`, `tasks.md`, contracts, and checklists;
4. the repository rules in [`AGENTS.md`](AGENTS.md).

Spec Kit artifacts are durable project state. The applicable `tasks.md` is authoritative for task
completion, and an accepted requirement must not be changed merely to fit an implementation.

Use English for normative artifacts, code, tests, issues, and public documentation. Keep changes
bounded, preserve unrelated work, and do not present planned integrations as shipped support.

## Local validation

Use Node.js `24.x` with the pinned pnpm `11.24.0` toolchain:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm validate
pnpm exec playwright install --with-deps chromium
pnpm test:acceptance
```

`pnpm validate` runs formatting, lint and dependency-boundary checks, lockfile and Compose image
checks, the credential-like material scan, typechecking, and deterministic unit, contract,
integration, recovery, security, and capacity suites. The browser suite is a separate gate. More
detail is available in the [local evaluation guide](docs/operations/local-evaluation.md).

No provider, harness, subscription, or user credential is required for the current fixture-only
implementation. Never add credentials, tokens, cookies, authentication caches, private keys, or
private model reasoning to code, fixtures, logs, issues, or artifacts.

The current local path is validated only on macOS ARM64 and Linux x64. A dependency update that
changes `embedded-postgres` or its native packages must update the exact versioned `allowBuilds`
entries in `pnpm-workspace.yaml` in the same pull request; unexpected native build scripts fail
closed.

## Proposing a change

- Use the issue forms for reproducible bugs and bounded feature proposals.
- For a substantial change, align on the problem and scope before implementation.
- Follow the installed Spec Kit lifecycle at a depth proportionate to risk.
- Prefer a deterministic fake backend before a real provider or harness integration.
- Keep model APIs and coding harnesses as distinct backend families.
- Do not claim a provider or authentication mode is supported without a current compatibility review
  and conformance evidence.

## Pull requests

A pull request should state:

- the problem and bounded outcome;
- relevant Spec Kit task or decision IDs;
- user-visible, contract, security, or migration impact;
- deterministic validation performed;
- unresolved decisions or known limitations.

Security, authorization, persistence, concurrency, runner isolation, public-contract, and other
cross-cutting changes require independent review. Completion claims must be backed by evidence tied
to the reviewed revision.

By intentionally submitting a contribution for inclusion in Moonshift, you agree that it is provided
under the [Apache License 2.0](LICENSE), consistent with section 5 of that license, unless you
conspicuously state otherwise before inclusion.

Please follow the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Report vulnerabilities privately under
the process in [`SECURITY.md`](SECURITY.md).
