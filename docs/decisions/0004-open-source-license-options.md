# ADR 0004: License Moonshift Under Apache-2.0

- **Status**: Accepted
- **Date**: 2026-09-02
- **Decision owner**: Human supervisor
- **Decision gate**: Satisfied before public repository launch

## Context

Moonshift is intended to be an open-source, self-hosted platform. The repository must not silently
select a license. The choice affects downstream redistribution, hosted modifications, commercial
adoption, contributor expectations, and compatibility with dependencies. This record is a product and
governance comparison, not legal advice.

## Option A: Apache License 2.0

Apache-2.0 is a permissive license with an express patent grant and notice obligations. It generally
allows private modification, proprietary redistribution, and hosted services without requiring those
modifications to be published. It can maximize adoption and integration, including commercial use,
but permits closed derivatives and hosted offerings that do not return platform improvements.

## Option B: GNU Affero General Public License v3.0

AGPL-3.0 is a strong copyleft license. Distributing a modified version, and offering a modified version
for remote network interaction, generally carries corresponding-source obligations under its terms.
It better protects reciprocal access to improvements in a self-hosted network product, but may reduce
adoption by organizations with policies against strong copyleft and complicate some dependency or
commercial integration choices.

## Decision

Moonshift is licensed under the **Apache License 2.0**. The repository carries the unmodified license
text in [`LICENSE`](../../LICENSE), and the root package metadata uses the SPDX identifier
`Apache-2.0`.

The deciding priority is broad genuine open-source adoption across self-hosters, integrators, coding
harnesses, provider adapters, and commercial environments. Apache-2.0 also provides an express patent
grant and clear notice obligations without adding field-of-use, hosted-service, branding, or
multi-tenant restrictions.

## Evidence and trade-offs

The decision compared current licenses of adjacent projects on 2026-09-02. OpenHands, Langflow, and
GitLab Community Edition use permissive MIT licensing. Apache-2.0 offers similarly low integration
friction with a stronger explicit patent grant. By contrast, Dify's modified license, n8n's
Sustainable Use License, and Airbyte's Elastic License 2.0 add commercial or hosted-service
restrictions and are not treated here as standard OSI open-source precedents.

Primary references:

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) and its
  [OSI entry](https://opensource.org/license/apache-2.0)
- [GNU Affero General Public License v3.0](https://opensource.org/license/agpl-3.0)
- [OpenHands license](https://github.com/All-Hands-AI/OpenHands/blob/main/LICENSE)
- [Langflow license](https://github.com/langflow-ai/langflow/blob/main/LICENSE)
- [GitLab licensing guidance](https://docs.gitlab.com/development/licensing/)

Apache-2.0 deliberately permits proprietary modifications and hosted offerings without requiring
their source to be published. AGPL-3.0 would better enforce reciprocity for modified network services,
but would also narrow proprietary integration and organizational adoption. The supervisor selected
adoption and interoperability as the stronger priority for Moonshift's provider-agnostic ecosystem.

The dependency inventory was reviewed with `pnpm licenses list`. Current runtime dependencies use
permissive licenses. Development tooling includes `@sourcemeta/jsonschema` under AGPL-3.0; it is not
linked into or distributed as Moonshift runtime code. Release packaging must continue to produce an
SBOM and review the exact distributed dependency graph.

This record documents a product decision, not legal advice. Qualified legal review remains advisable
before commercial distribution or a production release.

## Earlier decision criteria

The human supervisor must decide the priority among:

- broad permissive adoption versus reciprocal publication of platform modifications;
- tolerance for proprietary hosted derivatives;
- expected commercial and contributor model;
- compatibility of the final dependency graph and bundled artifacts;
- desired patent protections and notice process;
- whether a future dual-license model is intended and operationally supportable.

## Consequences

- Source, documentation, and accepted contributions are available under Apache-2.0 unless a file
  clearly states otherwise.
- Vendored or derived material retains its upstream license and attribution, as recorded in
  [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) and colocated license files.
- Contributions submitted for inclusion are handled by Apache-2.0 section 5; no contributor license
  agreement is introduced by this decision.
- No Commons Clause, hosted-service restriction, branding condition, or other non-standard term is
  added to the license.
- A future relicense or dual-license model requires a new decision and a contributor-rights analysis;
  this decision does not assume those rights can be obtained later.
- Trademark rights are not granted beyond Apache-2.0 section 6.
