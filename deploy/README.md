# New dedicated database bootstrap

`bootstrap.mjs` is a one-time administrative job for a **new, empty, dedicated**
PostgreSQL database named `agent_tasks`. It must never run against the Issuer,
mail service, Agent Workspace or an existing application database. It rejects
pre-existing application schemas, public objects and its named roles.

Build `Dockerfile.bootstrap` from the repository root. Give a temporary private
bootstrap service the new database's administrator URL, the documented application
configuration, `BOOTSTRAP_NEW_AGENT_TASKS_DATABASE=yes`, and two independent,
random 64-character hex values named `MIGRATION_PASSWORD` and `RUNTIME_PASSWORD`.
Keep secrets in the hosting platform, never in source, shell arguments, logs or an
image. This service needs no public HTTP domain or database TCP proxy.

The job creates a migrator with DDL rights inside this dedicated database and a
runtime role with only the documented data/function grants. It runs the exact
packaged schema migrations, checks both schemas as the runtime user, and confirms
runtime migrations fail. Successful output is a sanitized JSON record with
`event: agent_tasks_bootstrap_complete`; process success alone is insufficient.

After success, delete the temporary bootstrap service and its variables. Store the
migrator credential in the protected operator deployment record for future reviewed
migrations. The application service receives only the runtime database URL and its
own independent state/session secrets. Its admission list starts empty. Do not copy
administrator or migrator credentials into application variables or pre-deploy steps.

## Partial failure

Role creation and database ACLs commit before schema migrations. If any later step
fails, initialization can be partial. Re-running the job deliberately refuses this
state; do not relax the preflight or point it at another database to make it pass.
Keep the application stopped and preserve the sanitized failure and resource IDs.
For a newly provisioned database with no admitted users or application data, an
operator may approve discarding **only that new database service and volume** and
recreating them with fresh secrets. Otherwise use a separately reviewed repair after
inspection. Destructive recovery is not automatic and no script drops a database.

## Backup, restore and rollback

Enable daily volume backups before admitting users, record the platform's actual
retention and a successful snapshot ID, and confirm an operator receives failure
alerts. A snapshot record is not proof that a restore was tested. Rehearse restoration
into a separate service; keep both the restored service and its admission list closed.
Before admitting users after a restore, purge all callback states and sessions and
rotate application state/session secrets; preserve tasks and reconcile current
identity authority with the Issuer. Never restore old secrets and declare credentials
valid merely because their saved expiry has not passed.

Rollback to a compatible application image preserves the current database and
current secrets. Record source commit, deployment ID, image identity, migration
version and successful readiness for each release. The first release has no prior
known-good application image; disabling admission and stopping the service is its
rollback, while retaining its data and backups.
