# Local evaluation

This is the supported implementation-local setup for the current `001-supervised-autonomous-loop`
slice. It is a developer and test-fixture workflow, not an installation or production deployment.

## Prerequisites

- A macOS ARM64 or Linux x64 host. These are the only platforms validated for the current alpha;
  native dependency build scripts intentionally fail closed on other platforms.
- Node.js `24.x` (the repository engine range is `>=24 <25`), with Corepack enabled.
- pnpm `11.24.0` (the `packageManager` field and lockfile are pinned to this version).
- Git.
- PostgreSQL 18 for integration tests. The repository also includes `embedded-postgres` for the
  deterministic test path when Docker or `psql` is unavailable.
- A modern browser only for the Playwright acceptance suite.

No provider, harness, subscription, or user credential is required or expected.

Dependency updates that change `embedded-postgres` or one of its platform packages must update the
exact versioned `allowBuilds` entries in `pnpm-workspace.yaml` in the same revision. Unexpected native
scripts remain a hard installation failure under `strictDepBuilds`.

## Commands that exist today

From the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm lockfile:check
pnpm compose:check
pnpm typecheck
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:runner
pnpm test:recovery
pnpm test:security
pnpm test:capacity
pnpm test:acceptance
```

The aggregate local gate is `pnpm validate`; it runs formatting, lint/boundary checks, lockfile and
Compose image checks, secret scanning, typechecking, and the unit, contract, integration, recovery,
security, and capacity suites. Use `pnpm test:acceptance` when the browser fixture environment is
available. `pnpm clean` removes generated package build output and local test reports.

`compose.yaml` is a loopback-only PostgreSQL fixture (`127.0.0.1`, default port `55432`) with a
content-addressed image digest and a 2 GiB memory limit. `.env.example` contains local, passwordless
fixture defaults; it is not a production configuration. Do not expose the database or control plane
on a non-loopback interface.

There is currently no root script that starts a complete `moonshift` service or installs the CLI.
Commands such as `moonshift init`, `moonshift up`, `moonshift backup`, and `moonshift restore` are not
available; do not infer them from the conceptual lifecycle in planning artifacts.

## Architecture conformance

The current slice keeps the intended boundaries visible in source:

- `apps/control-plane/` owns orchestration, durable state, HTTP, scheduling, and projections.
- `apps/runner/` is a separate fixture-only process boundary.
- `apps/web/` is the browser projection; `apps/cli/` is a thin loopback inspection client.
- `packages/domain`, `policy`, `persistence`, `artifacts`, `context`, `verification`, and
  `backend-fake` own provider-neutral contracts and adapters.
- `packages/persistence/src/migrations/` contains versioned SQL migrations with manifest checksums;
  migration execution is forward-only and rejects unknown or changed applied migrations.

The fake backend and runner are the only execution path in this slice. The runner accepts fixture
operations over owner-local TLS 1.3 mutual authentication, denies network, has no arbitrary shell
operation, requests no GPU, and is eligible only for its fixture profile. These properties are
conformance evidence for the fixture boundary, not a claim of OCI or hostile-workload isolation.
