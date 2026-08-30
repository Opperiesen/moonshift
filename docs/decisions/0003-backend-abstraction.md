# ADR 0003: Use Moonshift-Owned Execution Backend Contracts

- **Status**: Accepted
- **Date**: 2026-08-30
- **Decision owners**: Founding architecture
- **Supersedes**: Narrow `ProviderAdapter` concepts

## Context

Moonshift must use model APIs, agentic coding harnesses, gateways, and local runtimes without turning
any provider's types or session model into agent identity or canonical state. These resources have
different authentication, tool, event, cancellation, usage, and resumability semantics.

## Decision

Define a Moonshift-owned `ExecutionBackend` boundary with three families:

- `ModelApiBackend` for protocol-driven inference APIs;
- `CodingHarnessBackend` for already-agentic tools that manage repositories, sessions, and tools;
- `LocalRuntimeBackend` for owner-controlled local execution resources that need distinct discovery
  and privacy treatment.

Owned request, event, result, error, capability, usage, tool, and checkpoint contracts cross the
boundary. Protocol adapters may expose profiles such as OpenRouter or a generic OpenAI-compatible
endpoint, but profile brands do not enter domain entities. API-key and subscription connections are
separate objects. Capabilities are probed, not inferred from a provider name.

Every supported adapter passes a common conformance harness plus family-specific tests. Routing uses
capabilities, classification, health, quota, cost, latency, policy, and review-diversity requirements.
Provider session identifiers remain optional hints inside provider-neutral checkpoints.

## Consequences

- The deterministic fake backend is the first implementation and contract oracle.
- Not all backends need resume, tools, schema output, or monetary usage; absence is explicit.
- Gateways and local endpoints can reuse protocol adapters only after capability conformance.
- Translation cost is accepted to preserve identity, recovery, audit, and replaceability.
- Adapter version and terms evidence must be dated and renewable.

## Rejected alternatives

- **OpenAI types as internal contracts**: leaks one protocol into the domain.
- **One adapter interface for APIs and harnesses**: hides materially different lifecycles and security.
- **Brand enumeration in domain code**: prevents protocol reuse and future replacement.
- **Provider conversation as state**: breaks checkpoint-and-switch and data sovereignty.
