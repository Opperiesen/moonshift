# ADR 0004: Choose an Open-Source License Before Public Release

- **Status**: Proposed — human decision required
- **Date**: 2026-08-30
- **Decision owner**: Human supervisor
- **Decision gate**: Before the first public release or acceptance of external contributions

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

## Decision criteria

The human supervisor must decide the priority among:

- broad permissive adoption versus reciprocal publication of platform modifications;
- tolerance for proprietary hosted derivatives;
- expected commercial and contributor model;
- compatibility of the final dependency graph and bundled artifacts;
- desired patent protections and notice process;
- whether a future dual-license model is intended and operationally supportable.

Before deciding, obtain qualified legal review, inventory planned dependencies and generated assets,
and document copyright ownership and contribution policy. Do not accept code under ambiguous terms.

## Interim rule

Until this ADR is accepted with one option, the repository is **not licensed for public reuse**. Do
not add a `LICENSE` file, publish a release, or imply OSI-granted permissions. Documentation may state
the open-source intent and that the license decision is pending.

## Consequences of deferral

Private planning and implementation may continue. Public release, broad external contribution intake,
and claims about license compatibility are blocked at the decision gate.
