# Manual npm registry acceptance

This workflow is dispatched only after all nine exact beta packages have been
published and their artifact integrities verified. Its default confirmation is
false; pushes and pull requests cannot start this registry-only job. It has read-only
repository permission and no production credentials, deployment step or live API test.

The job checks the original public release manifests against committed SHA-256
pins, resolves exact package names into a disposable consumer, and rejects non-npm
sources, workspace links and mismatched release SHA-512 integrity before installing.
Installation uses an empty cache and disabled lifecycle scripts with an isolated npm
configuration. Runtime code and the repository's existing GitHub-release lock stay
unchanged. Consumer imports, CLI help and real stdio MCP inventories are exercised.

Agent Tasks has 34 behavioral, HTTP and PostgreSQL tests and six distribution tests.
The six original distribution tests intentionally require GitHub release archives.
Only in this temporary consumer, they are replaced with six corresponding npm-only
origin, artifact-integrity and tampering checks. The other test files are copied
without changes. PostgreSQL runs as a disposable GitHub service with random test
schemas; it never connects to a production database.

The final report requires all 40 checks, nine package imports and a clean dependency
audit. MCP tests use synthetic configuration and an unreachable loopback mail target.
They establish package/protocol operation, not real AgentMail sign-in, device approval,
mail delivery, or new-human acceptance. GitHub destroys the disposable runner after
the job. Retain the uploaded report, lockfile, TAP output and audit as release evidence.
