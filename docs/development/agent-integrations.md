# Development Agent Integrations

This page describes tools that contributors may use to develop Moonshift. It does not define
Moonshift's runtime execution backends; those are owned by the product architecture in
[Execution Backends](../architecture/execution-backends.md).

## Default integration

Codex is the only Spec Kit integration installed by default in Iteration 0. Spec Kit 1.0.1 installs
its Codex skills under `.agents/skills/` and records the managed files in integration manifests.
Choosing Codex for repository development does not make OpenAI, Codex, or any provider part of a
Moonshift agent's identity or domain model.

## Optional contributor integrations

Contributors may install a supported Spec Kit integration for Claude Code, Gemini CLI, or
Antigravity in their own environment after checking `specify integration list` and the current
integration documentation. Do not commit credentials, vendor session stores, or machine-specific
configuration. Multi-install safety varies by integration; rely on `specify integration list` rather
than assumptions.

Optional development integrations have no product support implication. In particular:

- Claude Code has documented non-interactive and structured-output modes, but its subscription and
  API authentication modes remain distinct product-backend profiles.
- Gemini CLI has documented headless execution for API-key, Vertex AI, and cached Google sign-in
  modes. Current Google terms constrain third-party use of personal OAuth credentials.
- Antigravity currently documents an interactive CLI but no stable headless structured automation
  contract suitable for a supported Moonshift backend.

See the dated [backend compatibility research](../research/backend-compatibility-and-terms.md) before
planning or claiming a product integration. Re-verify official documentation and terms at adapter
implementation time.

## Local hygiene

- Keep authentication in the vendor tool's local credential store, outside Git.
- Never copy a personal subscription session into a shared runner or control plane.
- Use separate credential environments for trusted harness processes and untrusted repository jobs.
- Treat generated prompts, logs, transcripts, and context manifests as potentially sensitive.
- Run `specify integration status --json` after changing an integration.
