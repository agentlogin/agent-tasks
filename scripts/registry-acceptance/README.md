# Manual npm registry acceptance

This workflow is dispatched only after all nine exact beta packages have been
published and their artifact integrities verified. It currently targets the eight
Agent Login `0.2.0-beta.2` packages and `sentfromai-mcp@0.5.0-beta.2`.
Their GitHub archives are verified; npm acceptance has not yet run for these versions. Its default confirmation is
false; pushes and pull requests cannot start this registry-only job. It has read-only
repository permission and no production credentials, deployment step or live API test.

The job checks the original public release manifests against committed SHA-256
pins, resolves exact package names into a disposable consumer, and rejects non-npm
sources, workspace links and mismatched release SHA-512 integrity before installing.
Installation uses an empty cache and disabled lifecycle scripts with an isolated npm
configuration. Both runtime and development pins in the temporary package manifest
are replaced with the exact expected versions; existing RP dependencies cannot
silently retain the previous beta. Four offline preparation checks run in normal CI
and do not dispatch or satisfy registry acceptance. Runtime code and the repository's existing GitHub-release lock stay
unchanged. Consumer imports, CLI help and real stdio MCP inventories are exercised.
Legacy MCP uses `initialize`; the 2026-07-28 checks use `server/discover` and the
required metadata on every request, as defined by the current
[MCP versioning rules](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).

Agent Tasks has 34 behavioral, HTTP and PostgreSQL tests and six distribution tests.
The six original distribution tests intentionally require GitHub release archives.
Only in this temporary consumer, they are replaced with six corresponding npm-only
origin, artifact-integrity and tampering checks. The other test files are copied
without changes. PostgreSQL runs as a disposable GitHub service with random test
schemas; it never connects to a production database.

The final report requires all 40 checks, nine package imports and a clean dependency
audit. MCP tests use synthetic configuration and an unreachable loopback mail target.
Behavioral tests and the audit still run after an unrelated smoke failure when
installation succeeded; the final job remains failed unless every check passes.
They establish package/protocol operation, not real AgentMail sign-in, device approval,
mail delivery, or new-human acceptance. GitHub destroys the disposable runner after
the job. Retain the uploaded report, lockfile, TAP output and audit as release evidence.
