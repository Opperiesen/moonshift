# Release Model

Moonshift will use semantic versioning with `0.x` alpha releases until external contracts are
deliberately stabilized. Iteration 0 creates plans and contracts only; it is not a product release.

## Release units

Public releases are expected to include:

- control-plane OCI image;
- runner OCI image;
- Compose-compatible all-in-one evaluation bundle;
- split control-plane/runner deployment bundle;
- `moonshift` CLI binaries or a reproducible installation package;
- checksums, SBOM, provenance, release notes, and compatibility manifest;
- upgrade, backup, restore, rollback, and known-migration guidance.

Example image names remain placeholders until a public owner namespace is chosen:

```text
ghcr.io/<owner>/moonshift:<version>
ghcr.io/<owner>/moonshift-runner:<version>
```

The owner namespace and open-source license are human decisions. No image or package is published
before those gates are resolved.

## Versioning and compatibility

- Patch releases contain compatible fixes and documentation within the current alpha contract.
- Minor `0.x` releases may change alpha contracts but must publish migration and compatibility notes.
- A future `1.0.0` requires intentional stabilization of public API/event schemas, runner protocol,
  CLI behavior, backup format, and extension boundaries.
- Stored domain and event schemas carry explicit versions. Readers reject unsupported future versions
  rather than interpreting them loosely.
- Backend adapter support is a matrix of exact Moonshift, adapter, and upstream versions plus dated
  conformance/terms evidence.

## Release gate

A release candidate must bind all evidence to the candidate Git revision and include:

- clean reproducible builds for every shipped unit;
- unit, contract, integration, acceptance, restart, idempotency, migration, and restore results;
- independent Quality review and resolved blocking findings;
- security and dependency/supply-chain checks;
- complete requirement and Spec Kit convergence status;
- generated SBOM, checksums, provenance, and artifact signatures when the signing policy is selected;
- tested installation and rollback/restore procedure on the reference deployment profile;
- release notes with compatibility, known risks, and recovery boundaries.

An agent may assemble this evidence, but only policy and required human approval may authorize a
public release.

## Supply chain

Dependencies and build tools must be pinned through native lockfiles or content-addressed references.
Generated artifacts come from CI or a documented reproducible local process, never an opaque agent
workspace. Base images are digest-pinned at release time and refreshed through reviewed changes.
Release provenance links source revision, workflow identity, inputs, SBOM, and artifact hashes.

## Upgrade and rollback

Every upgrade declares supported starting versions, database and event migrations, runner protocol
compatibility, required downtime, backup prerequisites, and rollback limits. Schema changes use
forward-compatible expand/migrate/contract sequencing when practical. If downgrade is unsafe, the
documented recovery path is restore from the pre-upgrade backup.

## Deferred packaging

Kubernetes charts, desktop/mobile applications, marketplace distribution, managed SaaS, and automatic
production deployment are outside v0.1. They cannot be inferred from OCI packaging.
