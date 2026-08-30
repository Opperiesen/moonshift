# Security policy

Moonshift is currently **pre-publication and pre-implementation alpha**. There is no production service, supported deployment, or public security-response channel yet. Do not include secrets, credentials, cookies, tokens, or private model reasoning in issues, commits, or examples.

## Reporting a vulnerability

Once the GitHub repository is public, the planned private reporting path is a **GitHub Security Advisory** addressed privately to the maintainers. Please use that channel for suspected vulnerabilities rather than publishing exploit details in a public issue.

Until publication, do not disclose a suspected vulnerability publicly. If the private advisory path is unavailable, pause disclosure and obtain the project's current private reporting instructions from the maintainers; this document intentionally does not invent an email address or promise a response time.

Include only the minimum reproducible information needed to assess the issue: affected revision or artifact, impact, reproduction steps, and a suggested mitigation if known. Remove credentials and personal data before sending. Do not test against systems you do not own or have permission to assess.

## Security expectations

The constitution requires least privilege, separation between the control plane and execution runner, credential isolation, policy-gated sensitive actions, durable audit events, idempotent effects, and reconciliation after failures. Threat modeling includes prompt injection, malicious dependencies, secret access, privilege escalation, cross-project contamination, compromised model output, destructive Git operations, unauthorized egress, approval spoofing, and audit tampering.

These are project requirements and design targets, not a claim that they are already implemented. Security-sensitive changes must include targeted validation and independent review.
