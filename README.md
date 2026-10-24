# Agent Tasks

A separate Agent Login consumer built with Node's HTTP server and the public
`@agentlogin/rp` and `@agentlogin/rp-store-postgres` APIs. Agents sign in, create
private tasks and mark them complete. It does not import the reference example
or a sibling checkout at runtime. It is a second application integration, not an
independent implementation of the authentication protocol.

## Install the beta

The Agent Login dependencies are pinned to `0.2.0-beta.1` and available as official
[public GitHub release archives](https://github.com/agentlogin/reference/releases/tag/v0.2.0-beta.1).
The committed lockfile selects those HTTPS archives with SHA-512 integrity; ordinary
dependencies use the public npm registry. No npm login, local paths or sibling
checkout is needed:

```sh
npm run verify:lock
npm ci --ignore-scripts
PG_BIN=/path/to/postgresql/bin npm run test:postgres
```

This is public package distribution through GitHub Releases, **not a claim that the
Agent Login packages are published in the npm registry**. Keep the lockfile: a fresh
semver-only `npm install` can try the still-unpublished npm package names instead.
`distribution.json` records the canonical source commit, release-manifest hash and
each official archive's SHA-256/SHA-512. The lock verifier rejects local paths,
workspace links, unexpected origins and substitutions for those archives.
The Issuer package is development-only, for synthetic protocol tests.
Use the tested Node 22.23.4 patch or a newer tested maintained release.

## Configure the independent service

Use a new HTTPS origin and a separate application database with its own runtime
and migration roles. Do not reuse Agent Workspace's origin, schemas or secrets.
Set secrets through the deployment platform; never commit them or put them in URLs.

| Setting | Value |
| --- | --- |
| `BASE_URL` | Exact application origin without trailing slash, such as `https://tasks.sentfrom.ai` |
| `ISSUER` | `https://identity.sentfrom.ai`; this beta accepts this Issuer explicitly |
| `STATE_SECRET` | Random independent secret of at least 32 characters, shared by this service's replicas |
| `SESSION_SECRET` | Different random secret of at least 32 characters, shared by this service's replicas |
| `DATABASE_URL` | Authoritative PostgreSQL primary; no URL query overrides |
| `APP_DATABASE_SCHEMA` | `agent_tasks` |
| `CALLBACK_DATABASE_SCHEMA` | `agent_tasks_callbacks` |
| `DATABASE_TRANSPORT` | `tls` by default; verified certificates are required |
| `DATABASE_CA_FILE` | Optional trusted CA certificate file |
| `PORT` | Internal listen port, default `4010` |
| `NODE_ENV` | `production` |

`railway-private` transport is permitted only inside Railway's environment-isolated
private network, with an actual `*.railway.internal` database host and the platform's
`RAILWAY_PROJECT_ID`/`RAILWAY_ENVIRONMENT_ID`. It is not a TLS bypass for public database
endpoints. `loopback-test` works only for explicit local development origins and databases.
One shared pool per process has at most eight connections and a three-second checkout
timeout. Budget all replicas plus migration and monitoring against the database limit.

Run migrations once with a dedicated DDL role, using the exact release image, then
start with the restricted runtime credential. Startup verifies existing schemas and
never migrates. The migration job currently uses the same non-database configuration
as startup; keep its environment protected and do not pass secret values on a command line.

```sh
npm run migrate
npm start
```

The runtime needs schema `USAGE`, function execution, application schema-version
`SELECT`, and these table grants. Substitute the configured identifiers and actual
role; do not grant DDL, superuser, role administration or access to mail/identity data.

```sql
GRANT USAGE ON SCHEMA agent_tasks, agent_tasks_callbacks TO agent_tasks_runtime;
GRANT EXECUTE ON FUNCTION agent_tasks.app_now() TO agent_tasks_runtime;
GRANT SELECT ON agent_tasks.schema_version TO agent_tasks_runtime;
GRANT SELECT, INSERT, UPDATE ON agent_tasks.accounts, agent_tasks.tasks TO agent_tasks_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_tasks.sessions TO agent_tasks_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_tasks_callbacks.callback_states TO agent_tasks_runtime;
GRANT SELECT ON agent_tasks_callbacks.schema_migrations TO agent_tasks_runtime;
GRANT EXECUTE ON FUNCTION agent_tasks_callbacks.app_now_ms() TO agent_tasks_runtime;
```

For the container, build from this directory only:

```sh
docker build -t agent-tasks:beta .
```

The Dockerfile pins Node 22.23.4 and its immutable manifest digest. Record the resulting
application image digest. Configure `/readyz` as the deployment
health check, two replicas without sticky sessions, and at least 30 seconds of drain.
Liveness is `/healthz`; readiness checks the primary and schemas. A two-second readiness
cache coalesces probes. The service drains for 15 seconds before closing connections.
Apply external connection/request limits to login, callback and task endpoints before
admitting users. The application itself enforces request-body and per-account task limits;
these do not substitute for edge abuse controls. Configure continuous monitoring and
confirmed alert delivery separately from deployment health checks.

## Authentication and application policy

The login form is the SDK's packaged `signInForm`. Its handlers serve metadata,
start a PKCE sign-in, validate the callback and atomically consume shared callback
state before exchanging a code. The application creates its own random server-side
session after successful validation. Sessions are not shared with the Issuer, another
website or the human's browser when the agent uses its own helper.

Accounts and tasks are keyed by `(iss, sub)`, never email or handle. A recreated
identity gets a separate account. Sessions last one hour, without sliding renewal;
reads do not extend them. Cookies are host-only, Secure, HttpOnly and SameSite=Lax
outside explicit loopback development. Session identifiers are stored only as
namespace-bound HMACs. Short-lived UserInfo credentials use AES-256-GCM with binding
to the session, origin, issuer, subject and expiry; a bounded cleanup removes expired
ciphertext and sessions. Task content is rendered as text, never HTML.

Read-only session/task access is allowed until that application session expires or
is logged out. Every task creation/completion first checks UserInfo and then checks
the same local session and credential expiry inside the business transaction, after
locks and again before commit. An unavailable Issuer returns `503`, preserving the
session and performing no write. Explicit revocation returns `401` and deletes that
session. Revocation cannot retroactively stop an already authorized in-flight action,
and it is not a push notification ending all read-only sessions.

All browser/API mutations require the exact `Origin` and reject cross-site Fetch
Metadata; there is no CORS access. The MCP companion sends the configured origin.
Non-browser clients must do so too. A live check never holds an application database
transaction open. Logout deletes server-side state before clearing the cookie; an
uncertain database outcome produces `503` instead of a success claim.

Each agent may retain at most 100 tasks, each with a title of at most 200 characters
and 800 UTF-8 bytes. A task ID is 16–128 ASCII letters, digits, underscores or hyphens.
Creation with the same ID and title is idempotent; a different title returns `409`.
Completion is also idempotent. Writes are never retried automatically after an
uncertain response: list tasks and explicitly retry the same ID if appropriate.

## Configure an agent companion

Add this application to the user's existing private config only after they approve
the target. Replace the origin after deployment; a directory listing grants no access.

```json
{
  "name": "Agent Tasks",
  "origin": "https://tasks.sentfrom.ai",
  "loginPath": "/auth/agent/login",
  "sessionCheck": { "path": "/me", "handlePointer": "/handle", "issuerPointer": "/iss", "subjectPointer": "/sub" },
  "logoutPath": "/logout",
  "operations": {
    "list_tasks": { "description": "List this agent's private tasks", "method": "GET", "path": "/tasks", "output": { "tasks": "/tasks" } },
    "create_task": { "description": "Create a task with an id retained for an explicit retry", "method": "POST", "path": "/tasks", "inputFields": ["id", "title"], "output": { "saved": "/saved", "task": "/task" } },
    "complete_task": { "description": "Mark this agent's task complete", "method": "POST", "path": "/tasks/complete", "inputFields": ["id"], "output": { "saved": "/saved", "task": "/task" } }
  }
}
```

## Test and accept

`npm test` runs unit tests and uses `TEST_DATABASE_URL` for isolated random schemas.
Set `REQUIRE_POSTGRES_TESTS=1` in CI so missing PostgreSQL fails rather than skips.
Never point this at production. Alternatively, the local runner owns an entire
loopback-only disposable cluster and removes it afterward:

```sh
PG_BIN=/path/to/postgresql/bin npm run test:postgres
```

Tests cover encrypted session storage, different subjects/issuers with the same
handle, task quotas/idempotency, logout during UserInfo, expiry after lock waits,
uncertain commits, Origin/Fetch Metadata, callback replay and real cryptographic
sign-in over HTTP using installed packages. The synthetic Issuer bootstraps a test
Owner only inside the test; this is not evidence of real human onboarding.

CI installs the public artifacts into an empty cache without credentials, audits
production dependencies, and runs the PostgreSQL/HTTP/adversarial tests on PostgreSQL
17 and Node 22.23.4. It then builds the actual Docker image and checks nonroot execution,
safe refusal of missing production configuration, separate migrations, restricted
runtime grants, both-schema readiness and graceful shutdown against a disposable test
database. That container smoke explicitly uses loopback test transport; it does not
test production TLS termination or live infrastructure. Retain the CI run and image
evidence; writing a workflow is not evidence that its container job passed.

Before public launch, accept the exact locked release and container, deploy two
actual instances, test a fresh human-approved SentFrom identity through this website,
and collect routing evidence for callback/action/logout/revocation. An external
developer must follow these public instructions without unpublished help.

Keep backup and rollback recovery separate from code deployment. After an older
database restore, purge callback state and sessions and rotate both service secrets
before reopening; reconcile Issuer invalidations and identity ownership independently.
Keep current revocation data/secrets when rolling back a compatible application image.
Tasks have no automatic deletion in this beta; the named operator handles verified
account-deletion requests through a reviewed maintenance procedure. Assign that
operator and a real support route before inviting users.

Dependencies checked: [Node HTTP](https://nodejs.org/docs/latest-v22.x/api/http.html),
[node-postgres transactions](https://node-postgres.com/features/transactions),
[connection pooling](https://node-postgres.com/features/pooling).
Protocol basis: [Agent Login Core](https://github.com/agentlogin/spec/blob/main/agent-login-core.md),
particularly Sections 5.7 and 9.
