# Quickstart Validation: Supervised Autonomous Loop

**Status**: Runnable fixture-evaluation guide. The complete journey is driven by the repository's
deterministic Vitest and Playwright harnesses; no production installation or lifecycle CLI is claimed.

## What this proves

The quickstart proves the complete fixture-only journey with one supervisor, durable organization,
bounded delegation, deterministic fake execution, action-bound approval, revision-bound evidence,
independent Quality verification, pause/resume/stop, restart, reconciliation, cross-instance backend
resume, live browser projection, and a complete result/audit view.

It does **not** contact a model provider, use a subscription credential, execute arbitrary shell,
install fixture dependencies, push Git, expose a public service, deploy production infrastructure, or
claim general runner isolation.

## Prerequisites

- Node.js 24 LTS and Corepack
- PostgreSQL 18 reachable only from the local evaluation environment
- Git
- A modern desktop browser supported by Playwright
- Approximately 10 GB free disk and 8 GB available RAM for the single-machine evaluation path
- No provider or harness credential in the Moonshift evaluation environment

The repository lockfile selects pnpm `11.24.0` and every package version. The test fixture repository
is created from versioned content under `fixtures/supervised-loop-repository/`; do not substitute an
untrusted repository.

## Fresh local setup

From the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm contracts:validate
pnpm typecheck
pnpm test:runner
pnpm test:acceptance
```

The test harness starts only test-owned, loopback services and shuts them down after each suite. The
runner-process and browser suites prove the equivalent local readiness facts:

- control plane, PostgreSQL, artifact store, fixture runner, and both fake backend connections healthy;
- loopback-only bind confirmed;
- one Supervisor identity present;
- runner reports fixture operations only, arbitrary shell false, network denied, and one-job capacity;
- schemas and migrations current;
- no credential reference configured;
- zero active project or effect before the journey.

The browser harness creates a short-lived fixture bootstrap secret, presents it in a URL fragment,
exchanges it for a host-only HttpOnly session, and immediately removes the fragment. The bootstrap
tests fail reuse, expiry, wrong Origin, and non-loopback configuration. Secrets are fixed test data and
are never reusable credentials.

The fixture runner uses a separate loopback TLS 1.3 listener with owner-local per-instance mutual-TLS
identity. Its private keys are never printed. Before the journey, the process test must prove that an
unknown, expired, revoked, identity-mismatched, replayed, or plaintext runner connection is rejected
and that revocation closes the stream and fences its lease.

## Reference browser journey

1. Open **Projects** and submit: `Create a deterministic release-note artifact for the fixture`.
2. Confirm one Project identity and state appear; repeat the submission with the same test idempotency
   key and confirm that the same Project is returned.
3. Open **Observe** and confirm Product, Engineering, and Quality identities, the default channel tree,
   one Task, one Engineering Delegation, and one SpecialistIdentity.
4. Inspect the Delegation and confirm objective, reason, expected output, required evidence, capability,
   runtime, invocation/quota and synthetic monetary budgets, and archival conditions.
5. Confirm fake backend progress events show observable actions and concise rationale but no private
   reasoning, session prompt dump, or credential.
6. When the `WRITE_APPROVED_MARKER` request appears in **Supervise**, inspect the exact action digest,
   requester, reason, risk, expiry, and intended fixture target. Confirm the effect is not yet applied.
7. Approve the unchanged action. Confirm one effect appears and duplicate approve delivery returns the
   same terminal decision without a second fixture marker.
8. Observe the Specialist publish one hashed artifact and move the Task only to `CLAIMED_COMPLETE`.
9. Observe the separate Quality lineage start evaluation and the Task move to `VERIFYING`.
10. Confirm all deterministic evidence passes at the expected fixture Git revision and the Verification
    Engine, not an agent event, moves the Task to `VERIFIED`.
11. In a separate verification fixture, pause while an evaluation is `EVALUATING`; confirm it either
    commits while the Project remains `PAUSING` or becomes `STALE` before `PAUSED`, never verifies
    afterward, and is freshly evaluated on resume.
12. Restart only the control-plane process through the test control, reconnect with an intentionally
    expired event cursor, reload the Project projection, and resubscribe from its `lastSequence`.
13. Confirm identities, complete bounded-source presence, channel, task, approval, effect, artifact,
    evidence, checkpoints, and audit
    events retain their IDs and that the event list has no gap or duplicate.
14. Run the scripted runtime-loss scenario; confirm the old fencing token is rejected, effect ground
    truth is reconciled, and no duplicate marker appears.
15. Confirm `fake-secondary` resumes the same SpecialistIdentity and Task from a provider-neutral
    checkpoint through its own conformance relation; backend connection and runtime IDs change while
    the logical IDs and exact model-descriptor ID/version do not.
16. Open **Results** and confirm actual task state, artifact hash/revision, evidence matrix, approval,
    author/reviewer lineage, backend attempts, checkpoint/reconciliation history, and ordered audit
    timeline are visible.

## Automated acceptance

Run the complete deterministic suite:

```bash
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:runner
pnpm test:acceptance
pnpm test:recovery
pnpm test:crash-matrix
pnpm test:security
pnpm test:migration
pnpm test:restore
pnpm test:capacity
```

The browser suite contains passing, evidence-failure, approval-rejection, pause/interlock, recovery,
and Results scenarios. The capacity suite runs one, three, and five cognitive executions in one
invocation and records its aggregate metrics under test-owned `test-results/`.

Required results:

- all schema examples and generated types match the contract sources;
- every legal state transition succeeds and every illegal transition is rejected;
- the passing fixture verifies and every negative evidence fixture remains non-verified;
- each crash point before/during/after the effect converges to one semantic outcome with at most one
  marker;
- pause/resume/stop and cancellation retain audit and checkpoint evidence;
- pause preserves but cannot use pending approval, stop reaches recoverable `STOPPED` with revoked
  leases and cancelled approvals, resume mints fresh authority, terminal cancel cannot resume, and
  stop/cancel/completion races follow the first committed Project version;
- a pause racing an in-flight verification drains its atomic compare-and-commit while `PAUSING` or
  makes the evaluation stale before `PAUSED`; no later verification commit occurs until reevaluation
  after resume, and any Task verified during `PAUSING` cannot complete its Project until resume;
- the second fake connection reproduces the uninterrupted artifact and evidence result;
- each fake connection has a distinct conformance relation to the same descriptor ID/version, and
  start/resume/events/results retain connection and descriptor provenance independently;
- an expired event cursor reloads every active identity's bounded-source presence from ProjectView
  before resubscription, without using socket liveness as state;
- a changed evidence membership/hash/revision/policy makes the current evaluation stale and a fresh
  evaluation is required before verification;
- authorization tests show zero child specialist, self-approval, escalation, stale-fence,
  unauthenticated/replayed/revoked runner-message, or same-lineage review successes;
- schema/sanitizer tests prevent unknown/nested fields, credentials, authorization/private-key
  material, absolute/traversal paths, raw prompts/transcripts, and private reasoning from reaching
  storage, logs, events, errors, evidence, or UI;
- three-run and five-run event latency plus command/restart goals meet SC-006 through SC-008;
- no test opens an external network connection or finds credential material in process environment,
  logs, events, artifacts, or context manifests.

## Failure and recovery exercises

The recovery suite injects a hard process stop at each persisted boundary:

```text
before effect intent commit
after effect intent / before runner dispatch
after runner dispatch / before fixture mutation
after fixture mutation / before runner result
after runner result / before effect APPLIED commit
after effect commit / before outbox publication
after outbox publication / before browser acknowledgement
```

Run `pnpm test:crash-matrix` for the effect boundaries and `pnpm test:recovery` for the complete
restart/reconciliation suite. For every point, the tests restart the relevant boundary, run
reconciliation, replay the event projection, and assert a single semantic effect and complete audit
causality. An indeterminate fixture ledger must leave the effect `UNKNOWN`/reconciling and block
supervisor attention; it must not retry blindly.

## Backup and restore exercise

Run the fixture-owned migration and restore exercise:

```bash
pnpm test:migration
pnpm test:restore
```

The restored instance must validate the manifest, schema version, and artifact hashes; reconstruct the
same result and audit projection; and keep scheduling stopped until validation succeeds. The test
records final backup size, temporary backup/restore working-space high-water marks, and scheduling
downtime through validated projection rebuild against the declared reference disk envelope. The test
teardown removes only the temporary directories created by the tests.

## Evidence bundle

The final acceptance run writes a test-owned evidence bundle containing:

- Moonshift Git revision, fixture Git revision, migration version, lockfile hash, and contract hashes;
- policy, persona, verification-rule, fake-backend, and runner protocol versions;
- test reports for unit, contract, integration, browser, recovery, security, capacity, and restore;
- p50/p95 event and command latency, memory high-water marks, queue/outbox lag, restart time, runner
  resource/enforcement probes, backup/restore storage high-water marks, and restore downtime;
- artifact and checkpoint hashes, approval and effect IDs, reconciliation outcomes, and Quality lineage;
- a requirement-to-test coverage report and unresolved findings.

The bundle must contain no secret, raw session material, private chain-of-thought, or absolute
machine-specific credential path.

## Teardown

```bash
pnpm clean
```

The command removes only repository-generated build, coverage, Playwright, and test-result output.
Every fixture suite separately removes its own temporary PostgreSQL, artifact, runner, and browser
state. Copy any evidence report that must be retained before running `pnpm clean`.
