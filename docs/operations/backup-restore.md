# Fixture backup and restore contract

Backup and restore are a fixture-evaluation contract, not a production scheduling feature. The
contract is defined by the active feature plan/research and must remain conservative until executable
implementation and revision-bound evidence exist.

## Consistency set

A backup is one consistent snapshot containing all of the following:

1. A repeatable-read PostgreSQL snapshot of authoritative aggregates, events, audit,
   outbox/idempotency state, leases, project state, and artifact metadata. The derived project-event
   checkpoint is deliberately rebuilt during restore.
2. The owner-local artifact byte tree referenced by that metadata.
3. Opaque configuration references (identifiers or secret references only), never secret values,
   provider cookies, tokens, private keys, or session material.
4. A manifest recording the schema/migration version, opaque configuration references, contract
   hashes, and the size and hash of every backed-up database/artifact file. The final evidence bundle
   binds the exercised backup to its exact Git revision.

Database metadata and artifact bytes must be treated as one consistency set. A metadata dump without
its referenced bytes is not a restorable backup.

## Restore gate

Restore must validate the manifest and contract hashes, verify the supported migration/schema range,
verify artifact ownership and hashes, and rebuild durable projections before scheduling is allowed to
resume. Any missing, changed, unknown, or unverifiable item fails closed and leaves scheduling
stopped for supervisor attention. Restore must not silently retry effects or fabricate audit history.

The restore API requires its reconstruction callback to return a structured project-event proof. The
restore orchestrator then independently compares that proof with every restored project snapshot,
requires an exact project-event checkpoint at each snapshot's final sequence, and requires no
unpublished outbox event. An absent callback, a no-op callback, a blocked project, an incomplete
checkpoint, or a reconstruction failure cannot produce `schedulingMayResume: true`.

Migrations are forward-only. Before applying a migration, take a backup of the pre-upgrade set. A
rollback for an unsupported downgrade is restoration of that pre-upgrade set; automatic down-migration
is not promised.

## Current availability and limits

The repository exposes fixture backup validation/restore APIs, migration code, and deterministic
persistence/recovery tests. It does not provide a production backup scheduler, a general
retention/deletion policy, or a complete `moonshift backup`/`moonshift restore` CLI. Do not infer those
capabilities from this contract or the feature quickstart. The acceptance target is a local,
fixture-owned recovery exercise only; retention periods and deletion remain human decisions.
