# Validation configuration

The dependency-boundary and secret-pattern files are consumed by the local validation script.
They intentionally contain policy only; no credentials or provider configuration belongs here.

`vendor/` contains the official OpenAPI Initiative OpenAPI 3.1 validation schemas used by the
offline contract suite. They are pinned to schema revision `2025-11-23` and dialect/meta revision
`2024-11-10`; their `$id` values retain the normative upstream URLs. Local SHA-256 values are:

- schema-base: `8b0e9d1936ea893c253f051ef982a25e5fb95d583b4e04806e078991c3a9dd33`
- schema: `e07b1f0a554fb0fafa6acaebf6756484c0660d43fc5c1811c85b00faf635fb92`
- dialect: `92b8e4058dfc3c0701703a7a392aaca06bd26ffbab08ce29b85637c3c07fa70c`
- meta: `bed3dbb00311a6aa1c5495027c5485abc4db188338763c40614b7166210455da`
