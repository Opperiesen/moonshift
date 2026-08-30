# Technical Research: Supervised Autonomous Loop

**Status**: Phase 0 complete
**Researched**: 2026-08-30 to 2026-08-31
**Scope**: Choices required to plan the first deterministic vertical slice. Version-sensitive facts
must be rechecked when dependencies are locked.

## R-001 — Use end-to-end TypeScript for the first slice

**Decision**: Use Node.js 24 LTS and a pinned TypeScript toolchain across the browser, control plane,
fixture runner, administration CLI, contracts, and test fixtures. Preserve process and package
boundaries so a later runner or CLI can move to Go or Rust without changing domain contracts.

**Rationale**: The first slice is dominated by shared contracts, state transitions, browser
projections, deterministic fakes, and test orchestration rather than CPU-bound work. One language
reduces schema duplication and build/runtime footprint while proving the boundaries. Node 24 is an LTS
line as of the research date. An npm-compatible package with a `bin` entry is a reproducible CLI
installation path for alpha; native standalone binaries remain a release-slice decision.

**Alternatives considered**:

- **Go backend and CLI with TypeScript UI**: simple native binaries, low runtime overhead, and strong
  server concurrency. Rejected for slice 001 because it introduces cross-language contract generation
  before the domain stabilizes. It remains attractive if runner/CLI operational evidence later
  outweighs the shared-language benefit.
- **Rust backend and CLI with TypeScript UI**: strongest low-level resource control and portable
  binaries, but highest iteration and interoperability cost for the initial browser-heavy slice. Keep
  it as a future runner-security option, not a founding dependency.

**Evidence**: [Node release lines](https://nodejs.org/en/about/previous-releases),
[Go release policy](https://go.dev/doc/devel/release),
[Rust releases](https://doc.rust-lang.org/stable/releases.html),
[npm executable packages](https://docs.npmjs.com/cli/using-npm/scripts/),
[Go compile/install](https://go.dev/doc/tutorial/compile-install), and
[Cargo install](https://doc.rust-lang.org/nightly/cargo/commands/cargo-install.html).

## R-002 — Use a monorepo with a modular control plane and separate runner process

**Decision**: Use one package-managed monorepo. Keep a modular monolith for authoritative control-
plane behavior, a React browser app, a separate fixture runner process, a thin administration CLI,
and shared packages for domain, contracts, persistence, policy, verification, and fake execution.

**Rationale**: The topology preserves product and security boundaries without operationally expensive
microservices. The runner contract crosses a process boundary from the first slice. Domain packages
cannot import HTTP, UI, runner-runtime, or vendor adapter types.

**Alternatives considered**:

- Multiple repositories: rejected because atomic contract and acceptance-test changes are more
  important than independent release cadence in v0.1.
- Multiple control-plane services: rejected because one small PVE host and one active project do not
  justify distributed coordination.
- Control plane and runner in one process: rejected by constitutional plane separation.

## R-003 — Use PostgreSQL 18 as the single durable coordination baseline

**Decision**: Use PostgreSQL 18 for domain aggregates, explicit transitions, append-only audit/domain
events, transactional outbox, idempotency records, leases, approvals, checkpoints, artifact metadata,
and the initial job queue. Use `FOR UPDATE SKIP LOCKED` only for queue claiming, transaction-scoped
advisory locks where an aggregate needs serialized coordination, and `LISTEN`/`NOTIFY` only as a wakeup
hint after durable state is read.

**Rationale**: One durable dependency fits the small-host target and enables atomic state/event/outbox
writes. PostgreSQL explicitly documents `SKIP LOCKED` as useful for queue-like tables while warning
that it is not a general consistent-read mechanism. Notifications are asynchronous signals, not an
event log, so reconnect and recovery always read durable tables.

**Alternatives considered**:

- Redis or a message broker: rejected because it adds a second coordination truth and recovery burden
  before throughput evidence requires it.
- SQLite: excellent for single-process evaluation, but insufficiently representative of leases,
  concurrent workers, durable queue claiming, and the split control/runner target.
- Event-sourcing every aggregate: rejected as unnecessary complexity; use state tables plus an
  immutable event/audit history and outbox.

**Evidence**: [PostgreSQL 18 locking and `SKIP LOCKED`](https://www.postgresql.org/docs/18/sql-select.html),
[`LISTEN`](https://www.postgresql.org/docs/18/sql-listen.html),
[libpq notifications](https://www.postgresql.org/docs/18/libpq-notify.html), and
[advisory locks](https://www.postgresql.org/docs/current/functions-admin.html).

## R-004 — Use SSE for live browser projections and HTTP for commands

**Decision**: Use authenticated server-sent events for server-to-browser project activity and normal
HTTP commands/queries for supervisor actions. Event IDs are durable project sequence cursors. A
reconnect supplies the last seen ID; a cursor older than retained history receives an explicit reset
response and reloads the current projection.

**Rationale**: The first slice needs unidirectional durable event delivery, not a bidirectional socket.
SSE uses standard HTTP, provides event IDs and `Last-Event-ID` reconnect behavior, and keeps mutation
semantics on auditable HTTP commands. Delivery remains at least once; the browser deduplicates.

**Alternatives considered**:

- WebSocket: useful for bidirectional or high-frequency interaction but adds connection protocol,
  heartbeat, proxy, and reconnect complexity without a first-slice requirement.
- Polling: simple but weakens live presence and creates avoidable latency/load.

**Evidence**: [WHATWG server-sent events](https://html.spec.whatwg.org/dev/server-sent-events.html) and
[MDN SSE guidance](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).
Retention/cursor reset is explicitly Moonshift behavior because the standard does not define retained
server history.

## R-005 — Keep artifact bytes on a content-addressed local filesystem behind an interface

**Decision**: Store artifact metadata and hashes in PostgreSQL and bytes in an owner-controlled local
filesystem implementation for slice 001. Write to a temporary file, verify size/hash, atomically
rename into a content-addressed key, and never infer integrity from a storage key. Define an interface
whose semantics can be implemented by S3-compatible storage later.

**Rationale**: A local filesystem avoids operating another service on the 16 GB reference host and is
sufficient for deterministic fixtures. The interface prevents path or POSIX assumptions from leaking
into the domain. Backup/restore treats database metadata and artifact bytes as one consistency set.

**Alternatives considered**:

- S3-compatible service in the first slice: rejected as unnecessary memory, lifecycle, and backup
  burden. S3's strong object consistency is useful later but it is not a POSIX filesystem.
- Artifact bytes in PostgreSQL: rejected because large bytes complicate database backup, memory, and
  streaming without helping the domain contract.

**Evidence**: [Amazon S3 consistency](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html)
and [upload semantics](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html).

## R-006 — Use contract-first HTTP, event, backend, and runner boundaries

**Decision**: Version JSON Schema contracts for commands/events/backend/runner payloads and an OpenAPI
3.1 description for the supervisor HTTP surface. Generate or validate TypeScript types at build time;
do not use framework request objects as domain types. Contracts use strict envelopes with explicit
version, correlation, causation, aggregate, model-descriptor, and idempotency fields. Backend and
event observations are bounded, kind-specific allowlist projections. A single deterministic sanitizer
constructs those projections from untrusted input before any persistence, logging, audit, SSE,
evidence, error, or UI path; it rejects unknown fields, credentials, absolute/traversal paths, raw
prompts/transcripts, authorization material, and private reasoning.

**Rationale**: Schemas keep the web, modular control plane, separate runner, tests, and future language
implementations aligned. Contract evolution can be tested before the codebase has external consumers.

**Alternatives considered**:

- TypeScript-only shared interfaces: erased at runtime and unsuitable for process or future language
  boundaries.
- GraphQL in slice 001: adds schema and client tooling without a need for arbitrary graph queries.
- Framework-generated domain types: violates replaceability and makes migrations harder to reason
  about.

## R-007 — Keep the first runner real but capability-minimal

**Decision**: Implement the runner daemon/process boundary, registration, leases, fencing, heartbeat,
fixture workspace, and reconciliation protocol, but expose only deterministic fixture operations. Do
not offer shell execution or run repository lifecycle scripts in slice 001. Authenticate the
loopback-only runner link with TLS 1.3 mutual authentication under an owner-local per-instance CA.
Certificate URI identities bind the control-plane instance and enrolled runner to every message;
unknown/expired/revoked certificates, identity mismatch, replay, and plaintext fail before domain
handling. Revocation closes streams and fences leases. Private keys stay in an owner-only directory
and never enter payloads or logs.

Registration reports CPU, memory, process, disk, maximum-runtime, network, optional-GPU, and
per-control enforcement facts plus cgroup version, subordinate-ID availability, rootless runtime,
rootless network helper, storage driver, and filesystem class. The scheduler fails closed for any
requested unenforceable unit. Slice 001 accepts only `FIXTURE_PROCESS`, one job, denied network, and
zero-GPU requests. Rootless OCI discovery is recorded for later evidence, but an OCI profile or second
job remains in slice 006 and cannot become eligible merely because Podman is present.

**Rationale**: The vertical slice must prove authenticated authority, crash, and effect boundaries
without pretending that a fixture process provides production isolation. A separate process catches
boundary mistakes; mutual authentication prevents caller-supplied IDs from becoming authority; and
limiting the operation set prevents accidental expansion into a general remote shell.

**Alternatives considered**:

- Full rootless OCI execution now: rejected because it expands the slice into runner hardening and
  distracts from the supervised loop.
- In-process fake runner: rejected because it would not prove leases, heartbeat loss, fencing, or
  process-boundary contracts.

**Future probe evidence**: Rootless Podman requires user namespaces and subordinate IDs; storage and
network helpers vary, and cgroup v1 cannot enforce several rootless resource controls. The slice 001
registration schema records these facts but rejects non-fixture job profiles. Slice 006 must validate
`podman info`, cgroups v2, subordinate IDs, rootless networking, `fuse-overlayfs`, filesystem
suitability, and hostile-workload enforcement before enabling OCI work. See
[Podman rootless mode](https://docs.podman.io/en/stable/markdown/podman.1.html) and
[resource limits](https://docs.podman.io/en/latest/markdown/podman-update.1.html).

## R-008 — Use deterministic layered tests with real PostgreSQL

**Decision**: Use unit tests for pure state machines, policy, context selection, and verification;
schema/contract tests for every boundary; integration tests against a disposable PostgreSQL 18
database and fixture runner; browser acceptance tests for the supervisor journey; and a crash matrix
that interrupts before/during/after effect and outbox boundaries. Use a fake monotonic clock and seeded
scripts where determinism matters.

**Rationale**: In-memory persistence would hide transaction, lock, outbox, and restart failures. The
acceptance test binds all evidence to a controlled Git fixture revision and reconstructs projections
after process restart.

**Alternatives considered**:

- Mock database only: rejected because durability is a core acceptance property.
- End-to-end tests only: too slow and imprecise for transition and policy coverage.
- Real provider smoke tests: explicitly outside slice 001 and not deterministic.

## R-009 — Bind local evaluation to loopback and defer general authentication

**Decision**: Slice 001 creates one bootstrap Supervisor in a loopback-only evaluation deployment. It
must refuse non-loopback binding unless an explicit future authentication profile is configured. The
HTTP and event contracts still carry an authenticated actor identity so the boundary does not depend
on anonymous requests. `moonshift up` never prints session material. A separate `moonshift open`
command creates a short-lived, single-use bootstrap secret in owner-only local state and opens the
loopback browser with that secret in the URL fragment, which is not sent in the HTTP request. The SPA
immediately removes the fragment, exchanges the secret through the loopback-only bootstrap endpoint,
and receives a host-only `HttpOnly; SameSite=Strict` session cookie. The exchange validates the
expected Origin, expires after one use or a short timeout, is excluded from logs, and fails closed for
non-loopback binds. Tests obtain the same bootstrap secret through a test-only process fixture rather
than a public anonymous endpoint.

**Rationale**: This safely demonstrates one-human authority without making a premature durable auth
choice or exposing a network service. The first real backend or non-loopback deployment remains gated
by OD-007.

**Alternatives considered**:

- Password or external identity provider now: material product/security decision outside the slice.
- Anonymous network-accessible control plane: unacceptable even for alpha.
- Printing a reusable bearer token or placing it in a query string: rejected because terminals,
  process logs, browser history, and HTTP logs can retain it.

## R-010 — Use forward-only migrations and consistent backup sets

**Decision**: Version SQL migrations in Git and apply them transactionally where PostgreSQL permits.
Migration tests apply from empty and from the last fixture schema, then exercise the full acceptance
journey. Backups pair a consistent database dump with artifact bytes and a version/hash manifest.
Restore validates schema range and artifact hashes before scheduling resumes.

**Rationale**: The slice establishes the recovery contract without promising unsafe automatic
downgrade. Before a migration, the operator takes a backup; if downgrade is unsupported, rollback is a
restore of the pre-upgrade set.

**Alternatives considered**:

- Destructive auto-migration at startup: rejected because it obscures backup and rollback gates.
- Bidirectional down migrations as the only rollback: rejected because data-loss-safe reversal cannot
  always be guaranteed.

## R-011 — Reference capacity is an evidence target, not a reservation

**Decision**: Validate the acceptance journey on the documented 16 GB PVE-equivalent profile with the
control plane capped near 2–3 GB, one fixture runner job capped at 6 GB, three concurrent cognitive
executions by default, and a scripted ceiling test of five. Capture event latency, command
acknowledgement, memory high-water mark, queue delay, recovery time, consistent backup-set size,
temporary backup working-space high-water mark, restore working-space high-water mark, and scheduling
downtime from stop through validated projection rebuild.

**Rationale**: The target preserves host/PVE and filesystem-cache headroom. Scheduling by measured
resource units avoids equating idle agent identities with consuming processes.

**Alternatives considered**:

- Reserve resources per agent: rejected because identities are not runtimes.
- Claim two runner jobs without probing: rejected by the capacity requirement.

## R-012 — Pin a small current TypeScript delivery stack

**Decision**: Start implementation with Node.js `24.x` LTS, TypeScript `7.0.2`, pnpm `11.24.0`,
React `19.2.8`, Fastify `5.12.1`, node-postgres `8.23.0`, Vitest `4.1.11`, and Playwright
`1.62.1`. Use Vite `8.2.2` with `@vitejs/plugin-react` `6.1.1` for the browser build, Ajv `8.20.0`
through its Draft 2020-12 entry point for contract validation, and build-only
`@sourcemeta/jsonschema` `16.8.0` for Draft 2020-12 to TypeScript code generation. Pin exact resolved
dependencies and integrity in the repository lockfile.
The checked-in JSON Schema and OpenAPI files remain normative; generated TypeScript is disposable
derived output. Vendor the dated official OpenAPI 3.1 dialect/schema and validate the HTTP contract
with a separate Ajv 2020 instance plus a local conformance test. Fastify uses its core JSON Schema
validation/serialization behind the adapter; this slice does not generate the normative OpenAPI file
from routes and does not require `@fastify/swagger`.

**Rationale**: Each selected release is current, officially documented, and compatible with Node 24
as of 2026-08-31. The set covers the browser, minimal HTTP/SSE service, PostgreSQL client, unit and
integration tests, and browser acceptance without adopting an agent framework or external queue.
The code generator explicitly supports Draft 2020-12 and does not make the TypeScript compiler a
contract authority. A separate Ajv instance avoids mixing OpenAPI/Draft 2020-12 with any Fastify
route schema that uses an older dialect.

**Alternatives considered**:

- Node built-in HTTP without Fastify: fewer dependencies but more custom validation, error, and
  lifecycle code around a security-sensitive command boundary.
- A full-stack React metaframework: rejected because server rendering, edge deployment, and framework
  routing are not required and could blur the control-plane domain boundary.
- ORM and migration framework: deferred; plain reviewed SQL plus `pg` keeps transactions, locks, and
  state transitions explicit in the first slice.

**Evidence**: [Node release status](https://nodejs.org/en/about/previous-releases),
[TypeScript package metadata](https://registry.npmjs.org/typescript/latest),
[pnpm documentation](https://pnpm.io/), [React versions](https://react.dev/versions),
[Fastify v5 migration and Node support](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/),
[Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/),
[Vitest](https://vitest.dev/blog/vitest-4-1.html), [Playwright](https://playwright.dev/docs/intro),
and [node-postgres](https://node-postgres.com/), [Vite 8](https://vite.dev/blog/announcing-vite8),
[`@vitejs/plugin-react`](https://github.com/vitejs/vite-plugin-react),
[Ajv JSON Schema support](https://ajv.js.org/json-schema.html),
[SourceMeta JSON Schema code generation](https://github.com/sourcemeta/jsonschema/blob/main/docs/codegen.markdown),
and the [official OpenAPI 3.1 schema](https://spec.openapis.org/oas/3.1/schema/2024-11-10.html).

## Resolved unknowns

All Phase 0 planning questions have a decision or an explicit later human gate. The license, public
namespace, general authentication, retention, production OCI runtime, and long-term artifact backend
remain outside slice 001 and are tracked in [the decision register](../../docs/open-decisions.md), not
as `NEEDS CLARIFICATION` items in this plan.
