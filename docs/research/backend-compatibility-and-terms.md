# Backend Compatibility and Terms Research

**Status**: Iteration 0 planning evidence
**Last verified**: 2026-08-30
**Rule**: Re-verify the installed version, official automation surface, and applicable terms before
implementing or enabling any adapter. This document records evidence; it does not grant legal rights
or declare an integration supported.

## Status vocabulary

- **Verified**: an official source documents the stated interface or authentication mode.
- **Conditional**: official capability exists, but version, account, model, or terms constrain it.
- **Unverified**: no official stable contract was found for the claimed behavior.
- **Planned**: Moonshift architecture recognizes the target; no adapter exists.
- **Disabled by policy**: the known mode is unsuitable without a later terms and security decision.

## Compatibility summary

| Target/profile | Family | Official automation | API support | Subscription support | Iteration 0 status |
|---|---|---|---|---|---|
| OpenAI Codex CLI / SDK | Coding harness | Verified | Verified, separate mode | Verified local ChatGPT sign-in | Planned |
| Anthropic Claude Code / Agent SDK | Coding harness | Verified | Verified, separate mode | Verified Pro/Max sign-in | Planned |
| Google Antigravity CLI | Coding harness | Interactive only; headless contract unverified | Not established | Personal Google sign-in documented | Experimental, disabled by default |
| Gemini CLI | Coding harness | Verified headless mode | Verified Gemini API / Vertex AI | Personal Google sign-in documented but restricted for third-party use | API/enterprise planned; personal OAuth disabled by policy |
| OpenRouter | Model API profile | Verified HTTP API | Verified OpenAI-compatible chat endpoint | Not applicable | Planned conformance target |
| Generic OpenAI-compatible endpoint | Model API protocol | Conditional per endpoint | Configuration-dependent | Not implied | Planned protocol adapter |
| Local OpenAI-compatible endpoint | Local runtime / model API profile | Conditional per runtime | Configuration-dependent | Not applicable | Planned after probing |

No target is `supported` until an implementation passes the applicable Moonshift conformance suite.

## OpenAI Codex CLI and SDK

- **Official automation support**: `codex exec` is documented for non-interactive execution, including
  JSON event output. The SDK exposes typed results and interruptible turns.
- **Authentication**: ChatGPT sign-in and API-key modes are official and MUST be separate
  `BackendConnection` profiles.
- **Credential location**: OAuth tokens or API credentials are held in the local Codex credential
  environment and treated as secrets. The control plane stores only an opaque reference and health
  metadata.
- **Structured output**: JSON events and schema-constrained output are documented, but resume/schema
  combinations vary by installed version and require a version probe.
- **Resume/cancel**: session resume is documented; SDK turn interruption is documented.
- **Terms constraint**: ChatGPT access is not assumed to authorize credential redistribution or a
  shared multi-user service. Review the terms applicable to the instance owner and execution mode.
- **Evidence**: [Codex CLI](https://github.com/openai/codex/blob/main/codex-rs/README.md),
  [SDK getting started](https://github.com/openai/codex/blob/main/sdk/python/docs/getting-started.md),
  [SDK API reference](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md).

## Anthropic Claude Code and Agent SDK

- **Official automation support**: print mode accepts a prompt or stdin and can emit text, JSON, or
  streaming JSON with explicit turn and tool limits.
- **Authentication**: Anthropic Console/API, Claude Pro/Max, Amazon Bedrock, and Google Vertex AI are
  documented modes. Subscription and metered API connections MUST remain separate.
- **Credential location**: Claude Code manages local credentials; documented environment tokens and
  key helpers may be used in approved automated environments. They MUST not enter job containers.
- **Structured output**: JSON and streaming JSON are documented.
- **Resume/cancel**: continue/resume by session is documented. SDK execution is locally cancellable
  through an abort controller; no universal remote-job cancellation contract is inferred.
- **Terms constraint**: Pro/Max access is not treated as an API credential or redistribution right.
  Shared or CI use should prefer an explicitly authorized API or enterprise mode.
- **Evidence**: [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage),
  [Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk),
  [getting started](https://docs.anthropic.com/en/docs/claude-code/getting-started).

## Google Antigravity CLI

- **Official automation support**: official documentation describes an interactive `agy` terminal
  UI, task controls, resume, and internal scheduling. No stable external headless prompt flag,
  machine-readable event stream, execution SDK, or third-party control protocol was found.
- **Authentication**: Google sign-in with local keyring credentials is documented; personal AI
  credits may be consumed.
- **Credential location**: local keyring; it MUST remain outside the control plane and untrusted jobs.
- **Structured output**: unverified for external automation.
- **Resume/cancel**: interactive controls exist; programmatic contracts are unverified.
- **Terms constraint**: third-party orchestration using a personal session is not assumed to be
  permitted. This target remains experimental and disabled by default pending an official automation
  interface and a dated terms review.
- **Evidence**: [Antigravity overview](https://developers.googleblog.com/en/build-with-google-antigravity-our-new-agentic-development-platform/),
  [CLI reference](https://www.antigravity.google/docs/cli/reference/),
  [slash commands](https://www.antigravity.google/docs/slash-commands/).

## Gemini CLI

- **Official automation support**: headless prompt execution and text, JSON, or streaming JSON output
  are documented.
- **Authentication**: personal Google OAuth, `GEMINI_API_KEY`, and Vertex AI credentials are
  documented. Moonshift MUST model each mode separately.
- **Credential location**: cached personal credentials and project-scoped session/checkpoint data are
  local to the CLI environment; API and cloud credentials follow their official secret mechanisms.
- **Structured output**: text, JSON, and streaming JSON are documented.
- **Resume/cancel**: project-local session resume is documented. No remote cancellation protocol was
  found; process termination alone is not advertised as backend cancellation conformance.
- **Terms constraint**: Google's official terms/privacy guidance states that direct access to Gemini
  Code Assist through third-party software using Gemini CLI OAuth violates applicable terms. Therefore
  Moonshift plans API-key and Vertex AI/enterprise modes; personal OAuth orchestration is disabled by
  policy unless future official terms explicitly allow the integration.
- **Evidence**: [authentication](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx),
  [configuration and output](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md),
  [session management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md),
  [terms and privacy](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md).

## OpenRouter profile

- **Official automation/API support**: OpenRouter documents an OpenAI-compatible HTTP API at
  `https://openrouter.ai/api/v1`, bearer API keys, and provider-qualified model names.
- **Authentication**: dedicated API key; no consumer subscription mode is inferred.
- **Credential location**: secret reference resolved only in the credentialed backend environment.
- **Structured output and tools**: depend on the selected endpoint and model and MUST be discovered.
- **Resume/cancel**: no universal persistent agent-session contract is documented. Moonshift owns
  checkpoints, HTTP/stream cancellation, timeout, and reconciliation.
- **Terms constraint**: privacy and metadata handling require a data-classification review before code
  or private context is transferred.
- **Evidence**: [quickstart](https://openrouter.ai/docs/quickstart),
  [FAQ and privacy guidance](https://openrouter.ai/docs/faq).

## Generic and local OpenAI-compatible endpoints

An alternate base URL is a documented SDK configuration mechanism, not proof of complete semantic
compatibility. Each connection MUST probe authentication, supported endpoint family, streaming,
tools, structured output, usage, errors, limits, and cancellation. Responses-compatible and Chat
Completions-compatible capabilities MUST be advertised separately. Local endpoints MUST bind to an
approved private interface, and an absent credential MUST be an explicit configuration rather than a
silent default.

Resume and durable agent sessions are unsupported unless the endpoint exposes a separately documented
contract. Moonshift retains provider-neutral checkpoints regardless.

**Evidence**: [OpenAI Node authentication and base URL](https://github.com/openai/openai-node/blob/main/docs/authentication.md),
[OpenAI Agents SDK model configuration](https://openai.github.io/openai-agents-js/guides/models/).

## Implementation gate

Before an adapter can move from planned to supported, record: exact adapter and upstream versions;
official auth mode; terms-review owner and date; a credential-isolation test; capability probe output;
conformance results; failure and cancellation behavior; resume semantics; audit provenance; data
destinations; and an expiry date for the review. Unknown capabilities MUST be reported as unsupported,
not guessed.
