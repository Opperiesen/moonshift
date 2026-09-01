# Current Moonshift Work

- Active feature: `002-execution-backend-contracts`
- Allowed task range: planning artifacts only; the next separately started implementation checkpoint
  is `T001–T035`
- Checkpoint: `Feature 002 lifecycle preparation before US1; public repository fully verified`
- Status: `READY_FOR_US1_IMPLEMENTATION`
- Branch: `codex/002-execution-backend-contracts`
- Publication branch: `codex/public-repo-showcase`
- Feature 001 integrated base: `e9e3c05432b2356e5bf41eb4585339fa8d890399`
- Planning checkpoint: `4741d7f27de8132d338abd7f274a86f07117f7a3`
- Public-readiness checkpoint: `5b06975895054a252ca4589858caf050bf8a0760`
- Public CI repair checkpoint: `12f69f46ff90f4db1eea7d3b8d3dce8e2d72c6bb`
- Public CI portability checkpoint: `2cb6852944c371af0bf7345754ec6ce779a7c8b5`
- Public CI stability checkpoint: `569fb850657966e26512013d428fa46dba10e065`
- Public CI browser-bootstrap checkpoint: `ca3c0bff73b5328c936bd0dd2101032f1f34dfc3`
- Public CI green checkpoint: `56015e40eec19ecdace3dbf874b5b0dc23ad0534`
- Worktree: clean after the final publication continuity checkpoint; no Feature 002 implementation
  task has started
- Last updated: `2026-09-01T23:56:38Z`

## Completed public-repository preparation

- Apache-2.0 is the accepted Moonshift license under ADR 0004; colocated MIT notices and
  `THIRD_PARTY_NOTICES.md` preserve the attribution of derived GitHub Spec Kit extensions.
- ADR 0005 selects `github.com/Opperiesen/moonshift` as the canonical public repository. The OCI
  image namespace remains unresolved and unauthorized under OD-012.
- The repository is public with its root presentation, visual identity, honest alpha boundaries,
  contribution and conduct guidance, security policy, issue forms, pull request template, ownership,
  topics, description, and Apache-2.0 license visible on GitHub. The community profile is 100%.
- Repository and full-history credential-pattern scans found no credential-like material. The final
  post-repair independent review found no unresolved public-readiness blocker.
- Private vulnerability reporting, dependency alerts, Dependabot security updates, automated
  security fixes, secret scanning, push protection, and approval for all external fork contributors
  are enabled and verified.
- The first public CI runs exposed a fail-closed Linux native-build approval gap before validation.
  The repair pins the exact macOS ARM64 and Linux x64 native packages, keeps `strictDepBuilds`, limits
  routine Dependabot updates to minor/patch versions, and documents the supported hosts and atomic
  dependency-update rule.
- The synchronized Linux run then exposed an OpenSSL 3.0 portability gap in deterministic certificate
  fixtures. The final repair signs fixed-date certificates through the portable `openssl ca` path,
  asserts the exact validity window, and moves the CI actions to their supported Node 24 generations.
- Public run `33570909718` proved the Linux install, OpenSSL, and current Actions repairs, then exposed
  a stale-version race in one in-flight STOP test. The test now holds the applied runner result until
  STOP has durably reconciled the `EXECUTING` boundary, without changing production concurrency or
  adding retries. Public run `33571439073` proved that repair and reached the capacity test, where it
  exposed that Chromium was installed after `pnpm validate` despite being required during validation.
  The workflow now bootstraps Chromium first.
- Public run `33571933964` then passed the functional capacity assertions but exposed Linux
  PostgreSQL teardown errors and a local cold-cache reproduction exposed five parallel Vite servers
  invalidating one shared optimizer cache. Teardown now accepts only PostgreSQL `57P01` during the
  explicit embedded stop phase, and each acceptance server owns a distinct ignored cache.
- Public run [`33573046524`](https://github.com/Opperiesen/moonshift/actions/runs/33573046524)
  passed the clean install, Chromium bootstrap, complete validation, capacity teardown, 23 Chromium
  acceptance scenarios, and artifact upload on `main` at `56015e4`. No Dependabot pull request
  remains open; the former major-update proposals closed after the pinned workflow updates.

## Completed lifecycle preparation

- Feature 001 is complete through T086 and is integrated into local `main` and this branch.
- Feature 002 has completed `$speckit-specify`, `$speckit-clarify`, `$speckit-plan`,
  `$speckit-checklist`, `$speckit-tasks`, and cross-artifact `$speckit-analyze` preparation.
- The specification contains 36 functional requirements, 11 success criteria, deterministic
  acceptance scenarios, explicit fixture-only scope, and no unresolved clarification markers.
- The plan, research, data model, quickstart, six strict JSON Schemas, initial US1 OpenAPI contract,
  three reviewer-owned quality checklists, and 92 dependency-ordered tasks are present.
- Independent repository exploration and two planning-review passes were used. The fresh post-repair
  review approved T001–T035 readiness with no unresolved finding; all 93 reviewer-owned checklist
  criteria are approved and checked.

## Completed implementation tasks

None for Feature 002. All `T001–T092` task markers remain unchecked. This checkpoint deliberately
stops before implementation.

## First incomplete task

`T001` — record a clean Feature 001 contract, acceptance, recovery, and security baseline bound to the
starting revision. The next bounded implementation session may complete Foundation plus US1
`T001–T035`, must preserve contract-first RED evidence, and must stop with `T036` as the first
incomplete task.

## Principal planning files

- `specs/002-execution-backend-contracts/spec.md` — accepted behavior, trust boundaries, scenarios,
  functional requirements, success criteria, and exclusions
- `specs/002-execution-backend-contracts/plan.md` — architecture, security, persistence, migration,
  deterministic test strategy, and implementation phases
- `specs/002-execution-backend-contracts/research.md` — bounded decisions and rejected alternatives
- `specs/002-execution-backend-contracts/data-model.md` — identities, immutable evidence, relations,
  state transitions, and cross-entity invariants
- `specs/002-execution-backend-contracts/contracts/` — provider-neutral schemas and initial US1
  loopback supervisor API
- `specs/002-execution-backend-contracts/tasks.md` — authoritative T001–T092 execution state
- `specs/002-execution-backend-contracts/checklists/` — requirements, backend-contract,
  conformance, and security/recovery quality gates

## Verification evidence

| Command or gate                   | Result | Notes                                                                                                                                                                                                                   |
| --------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON Schema strict compilation    | PASS   | Six Draft 2020-12 schemas compile with Ajv `strict: true` and registered UUID/date-time formats                                                                                                                         |
| Initial OpenAPI structure         | PASS   | OpenAPI 3.1 parses and exposes only the two authenticated US1 qualification paths on the existing loopback API                                                                                                          |
| Task structure                    | PASS   | 92 unique sequential task IDs, exact checklist syntax, dependency/user-story ordering, and T001–T035 first checkpoint                                                                                                   |
| `pnpm clean && pnpm validate`     | PASS   | Pinned Node.js 24.20.0/pnpm 11.24.0; formatting, lint, boundaries, lockfile, image pins, secret scan, typecheck, 91 unit, 71 contract, 114 PostgreSQL integration, 33 recovery, 15 security, and 1 capacity test passed |
| `pnpm test:acceptance`            | PASS   | 23 Chromium acceptance tests passed                                                                                                                                                                                     |
| Web build                         | PASS   | Vite production build completed                                                                                                                                                                                         |
| Generated contract check          | PASS   | `pnpm contracts:generate` produced no tracked diff                                                                                                                                                                      |
| Independent final planning review | PASS   | Fresh post-repair reviewer approved readiness for T001–T035 and every criterion in the three reviewer-owned checklists                                                                                                  |
| `$speckit-analyze`                | PASS   | Final rerun: 36 FRs, 11 success criteria, 92 sequential tasks, complete reviewed coverage, 109 checked checklist items, and zero unresolved marker or contradiction                                                     |
| `git diff --check`                | PASS   | No whitespace errors                                                                                                                                                                                                    |
| Public-readiness validation       | PASS   | Pinned full `pnpm validate`, 23 Chromium acceptance tests, local Markdown-link resolution, YAML parsing, Apache/MIT license checks, SVG XML validation, and full-history credential-pattern scan                        |
| Independent public review         | PASS   | Fresh post-repair review found no unresolved blocker across license, ownership, claims, attribution, contribution, security, or GitHub community configuration                                                          |
| Public GitHub security            | PASS   | Visibility, metadata, Apache-2.0 detection, 100% community profile, private reporting, dependency alerts/updates, secret scanning/push protection, and external-fork approval verified                                  |
| Public CI cold-install repair     | PASS   | Exact native build approvals, supported-host boundary, Dependabot policy, unchanged lockfile, and pinned clean install passed in public run 33573046524                                                                 |
| Public CI OpenSSL portability     | PASS   | Portable fixed-date certificate generation, 55 targeted tests, full validation, and public Linux execution passed in run 33573046524                                                                                    |
| Public CI concurrency stability   | PASS   | Stale-version race diagnosed, 10 consecutive targeted runs, full pinned validation, and public Linux execution passed in run 33573046524                                                                                |
| Public CI browser bootstrap       | PASS   | Chromium installation precedes the capacity test inside `pnpm validate`; the capacity and acceptance phases passed in run 33573046524                                                                                   |
| Public CI teardown stability      | PASS   | Exact shutdown-phase `57P01` handling, 10 consecutive capacity runs, two full local validations, fresh independent review, and public Ubuntu validation passed                                                          |
| Parallel acceptance stability     | PASS   | Five isolated Vite caches; 5 consecutive cold-cache parallel runs plus the public 23-test acceptance phase passed without `Outdated Optimize Dep`                                                                       |
| Public `main` workflow            | PASS   | Run 33573046524 completed every step successfully on `56015e40eec19ecdace3dbf874b5b0dc23ad0534`; validation artifact uploaded                                                                                           |
| Dependabot cleanup                | PASS   | Zero open pull requests after the repository-pinned current Actions generations and minor/patch update policy took effect                                                                                               |

## Open findings and bounded limitations

- No unresolved specification, planning, contract, task, checklist, review, or validation finding
  remains at the pre-implementation checkpoint.
- All Feature 002 profiles, descriptors, adapters, reports, and support projections are deterministic
  test fixtures. No real model API, routing gateway, coding harness, local runtime, authentication mode,
  provider account, consumer session, or provider compatibility is implemented or claimed.
- Provider credential variables must be absent and fixture processes must enforce denied external
  network, arbitrary shell, and deployment capabilities in Foundation/US1 evidence.
- Open decisions OD-005–OD-007 and OD-009–OD-012 remain unresolved and cannot be inferred from
  fixtures or planning.
- The host defaults remain outside repository pins; authoritative validation uses the pinned Node.js
  24.20.0/pnpm 11.24.0 wrapper.
- No deployment, production mutation, OCI image publication, package publication, or release is
  authorized. Remote mutations are limited to the supervisor-authorized repository synchronization,
  public visibility, descriptive metadata, and repository security settings recorded in ADR 0005.

## Exact next action

In a separate task, start Feature 002 Foundation plus US1 at T001, complete only T001–T035, and do
not begin T036 until that US1 checkpoint has been accepted.
