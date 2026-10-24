import { readFileSync } from 'node:fs';
import { exactOrigin } from './app.mjs';

export function configuration(env = process.env) {
  try { return parseConfiguration(env); }
  catch { throw new Error('Invalid Agent Tasks configuration; check the documented settings'); }
}

// Do not propagate URL.input, filesystem paths, causes or credential-bearing values to CLI startup logs.
function parseConfiguration(env) {
  const base = exactOrigin(env.BASE_URL ?? '', env.NODE_ENV !== 'production');
  const issuer = exactOrigin(env.ISSUER ?? 'https://identity.sentfrom.ai', env.NODE_ENV !== 'production');
  const dev = base.startsWith('http:');
  if (!dev && issuer !== 'https://identity.sentfrom.ai') throw new Error('This beta accepts the SentFrom Issuer only');
  if (typeof env.STATE_SECRET !== 'string' || typeof env.SESSION_SECRET !== 'string' || env.STATE_SECRET.length < 32 || env.SESSION_SECRET.length < 32 || env.STATE_SECRET === env.SESSION_SECRET) throw new Error('Distinct shared state/session secrets of at least 32 characters are required');
  const portText = env.PORT ?? '4010';
  if (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535) throw new Error('Invalid PORT');
  const url = new URL(env.DATABASE_URL ?? '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.search || url.hash || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Invalid database configuration');
  let ssl;
  const transport = env.DATABASE_TRANSPORT ?? 'tls';
  if (transport === 'loopback-test') {
    if (!dev || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Loopback database transport is development only');
    ssl = false;
  } else if (transport === 'railway-private') {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.railway\.internal$/.test(url.hostname) || !uuid.test(env.RAILWAY_PROJECT_ID ?? '') || !uuid.test(env.RAILWAY_ENVIRONMENT_ID ?? '')) throw new Error('Private transport requires actual Railway network context');
    ssl = false;
  } else if (transport === 'tls') ssl = { rejectUnauthorized: true, ...(env.DATABASE_CA_FILE ? { ca: readFileSync(env.DATABASE_CA_FILE, 'utf8') } : {}) };
  else throw new Error('Unknown database transport');
  const appSchema = env.APP_DATABASE_SCHEMA ?? 'agent_tasks', callbackSchema = env.CALLBACK_DATABASE_SCHEMA ?? 'agent_tasks_callbacks';
  if (appSchema === callbackSchema || ![appSchema, callbackSchema].every(s => /^[a-z_][a-z0-9_]{0,49}$/.test(s) && !s.startsWith('pg_'))) throw new Error('Distinct safe schema names required');
  return { base, issuer, dev, port: Number(portText), stateSecret: env.STATE_SECRET, sessionSecret: env.SESSION_SECRET, appSchema, callbackSchema,
    database: { connectionString: url.href, ssl, max: 8, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30_000, options: '-c statement_timeout=5000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000 -c synchronous_commit=on' } };
}
