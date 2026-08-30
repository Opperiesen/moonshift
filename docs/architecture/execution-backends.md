# Execution Backends

An `ExecutionBackend` is a Moonshift-owned boundary for replaceable cognitive resources. Agent
identity, project state, tools, evidence, and checkpoints remain outside it. See
[ADR 0003](../decisions/0003-backend-abstraction.md) and the dated
[compatibility research](../research/backend-compatibility-and-terms.md).

## Backend families

```text
ExecutionBackend
├── ModelApiBackend
├── CodingHarnessBackend
└── LocalRuntimeBackend
```

`ModelApiBackend` translates Moonshift requests into an inference protocol. Initial protocol families
to plan are OpenAI Responses-compatible, OpenAI Chat Completions-compatible, Anthropic Messages,
current native Google Gemini, and explicitly configured generic HTTP adapters.

`CodingHarnessBackend` controls an already-agentic coding tool through a documented CLI or SDK. It
models harness health, authentication, non-interactive execution, structured events, tool/approval
bridging, interruption, checkpoint hints, artifact recovery, and quota metadata where available.

`LocalRuntimeBackend` represents owner-controlled local inference or specialized execution whose
discovery, privacy, and resource semantics need a distinct profile. An OpenAI-compatible local server
may reuse a protocol translator while still declaring local-runtime connection and policy properties.

## Owned contract surface

The common contract defines:

- backend and connection identity independent of brand display names;
- a separately identified and versioned `ModelDescriptor` selected by an Execution and never used as
  an agent, connection, runtime, or provider-session identity;
- a `ConnectionModelDescriptor` relation that records per-connection availability and conformance for
  an exact descriptor version, allowing multiple connections to expose one backend-scoped resource;
- version and health probe;
- `CapabilityDescriptor` values with evidence and probe time;
- provider-neutral input, streaming event, result, usage/quota, normalized error, and checkpoint data;
- start, bounded stream, timeout, and local cancellation semantics;
- optional resume, schema output, tools, artifacts, and session hints;
- context classification and external destination;
- audit correlation and idempotency keys.

Optional capabilities are explicit. The common interface does not pretend every API can resume or
every harness reports token costs.

An Execution retains the selected connection ID and exact model-descriptor ID/version independently.
Changing connections creates a successor Execution and selects a separately evidenced availability
relation; it does not clone the model descriptor or change agent/task identity.

## Connections and authentication

A `BackendConnection` selects one endpoint and one official authentication mode. API-key,
subscription, workspace, cloud, enterprise, and unauthenticated-local connections are separate even
for the same vendor. The control plane stores an opaque `CredentialReference`, ownership, status,
capabilities, expiry, and audit metadata—not credential material.

Personal subscription connections default to one active lease until measured and explicitly
configured otherwise. Subscription use reports plan and quota health; it does not invent per-task
monetary cost.

## Profiles and gateways

OpenRouter is an initial conformance profile for the OpenAI-compatible protocol. Other gateways, such
as LiteLLM Proxy, Portkey, Helicone, or Cloudflare AI Gateway, may become profiles when protocol and
privacy conformance is demonstrated. Their brands do not create domain subtypes. Arbitrary and local
OpenAI-compatible endpoints require capability probing because URL compatibility does not imply tool,
schema, usage, cancellation, or error compatibility.

Native adapters remain valid when a provider capability cannot be represented faithfully through a
compatible protocol.

## Conformance gate

No adapter is called supported until deterministic tests cover its applicable claims:

- capability and version discovery;
- authentication health without credential disclosure;
- input/output and streaming translation;
- structured output and tools when advertised;
- cancellation, timeout, retry, and rate-limit normalization;
- checkpoint/resume semantics and loss recovery;
- artifact and diff collection;
- usage, fixed-plan, or quota accounting without fabrication;
- credential isolation and context-destination audit;
- idempotent effects and reconciliation after interruption.

Slice 001 implements only the minimum deterministic fake boundary needed for scripted success,
approval, failure, interruption, restart, checkpoint, strict observable projection, and
backend-connection switch scenarios. Slice 002 generalizes this contract and conformance gate across
backend families; passing the fake minimum does not claim real-provider support.

## Initial harness targets

- Codex CLI / SDK: ChatGPT subscription and API key as separate connections.
- Claude Code / Agent SDK: Claude subscription and API/enterprise connections as separate modes.
- Antigravity CLI: experimental and disabled by default until official stable external automation and
  acceptable terms are verified.
- Gemini CLI: API-key and enterprise/cloud modes planned; personal OAuth orchestration disabled by
  policy under currently documented terms.
- Future harnesses: generic command/SDK adapter only when a structured, cancellable, auditable
  contract can be tested.
