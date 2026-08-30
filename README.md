# Moonshift

Moonshift is intended to become an open-source, self-hosted workspace for autonomous software development under the supervision of one human. It is provider-agnostic and designed to work with both model APIs and agentic coding harnesses through replaceable execution backends.

Moonshift is currently **pre-implementation alpha**. The repository is being prepared with product documentation, architecture decisions, and a first Spec Kit feature; the production application is not available yet. Nothing in this README should be read as a claim that provider integrations, deployment bundles, or runtime capabilities are already supported.

## Product direction

One supervisor gives Moonshift a software objective and observes a durable project organization of persistent personas and temporary specialists. The intended system will structure work, delegate bounded tasks, run work in an isolated execution plane, and require objective evidence before completion. The supervisor remains the root authority.

The planned product boundary is a browser control plane, an isolated runner, and an administration CLI. The initial target is self-hosting on a small Proxmox VE installation with remote inference; Moonshift is not local-model-only and does not require one model provider or one coding harness.

The v0.1 scope is deliberately limited to one human supervisor per self-hosted instance. Team accounts, multi-human RBAC, a managed cloud edition, Kubernetes distribution, marketplace, mobile or desktop-native applications, recursive specialists, and autonomous self-modification are out of scope for that version.

## Status and roadmap

The first independently testable slice is `001-supervised-autonomous-loop`: a deterministic fake backend, durable project state, bounded delegation, approval, auditable actions, evidence-based verification, restart/recovery behavior, and a browser projection. It is a planned slice, not a shipped feature.

Project foundations and the staged roadmap live in [`docs/feature-map.md`](docs/feature-map.md) when those artifacts are present. The governing principles are in [`.specify/memory/constitution.md`](.specify/memory/constitution.md).

## Development

Moonshift uses GitHub Spec Kit as its first development method. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution workflow and [`AGENTS.md`](AGENTS.md) for repository rules. Normative specifications, plans, tasks, and decision records remain versioned in Git.

There is no supported installation or production quickstart yet. Follow the active Spec Kit artifacts and task state rather than inferring commands from this overview.

## Security and licensing

Security reports are planned to use private GitHub Security Advisories once the project is public. Until publication, please do not disclose vulnerabilities publicly; see [`SECURITY.md`](SECURITY.md).

The open-source license is intentionally undecided. The comparison and required human decision are tracked in [`docs/decisions/0004-open-source-license-options.md`](docs/decisions/0004-open-source-license-options.md). No license or permission for public reuse should be inferred before that decision.

## Contributing

Private/internal collaboration may continue while the project is being shaped, subject to the current specifications and constitution. Broad external contribution intake begins only after the license and public-governance gates are resolved; see [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
