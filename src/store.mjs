import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class TaskError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
export class UncertainCommitError extends Error {
  constructor() { super('The commit outcome is uncertain; inspect current state before an explicit retry'); }
}
export const validSid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function validateTask(input, completing = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !(completing ? ['id'] : ['id', 'title']).includes(k)) ||
      typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(input.id) || (!completing &&
      (typeof input.title !== 'string' || !input.title.trim() || [...input.title].length > 200 || Buffer.byteLength(input.title) > 800 || /[\u0000-\u001f\u007f]/.test(input.title)))) throw new TaskError('invalid_task', 400);
}
const q = value => `"${value}"`;

/** Business authorization belongs to this application, separate from protocol callback storage. */
export class TaskStore {
  constructor({ pool, schema = 'agent_tasks', secret, namespace, checkpoint }) {
    if (!pool || !/^[a-z_][a-z0-9_]{0,49}$/.test(schema) || schema.startsWith('pg_')) throw new Error('Invalid task store configuration');
    if (typeof secret !== 'string' || secret.length < 32 || typeof namespace !== 'string' || !namespace) throw new Error('Session secret and namespace required');
    this.pool = pool; this.schema = schema; this.namespace = namespace; this.checkpoint = checkpoint;
    this.lookupKey = createHmac('sha256', secret).update('agent-tasks/session-lookup/v1').digest();
    this.encryptionKey = createHmac('sha256', secret).update('agent-tasks/token-encryption/v1').digest();
  }
  table(name) { return `${q(this.schema)}.${q(name)}`; }
  key(sid) { if (!validSid(sid)) throw new TaskError('not_signed_in', 401); return createHmac('sha256', this.lookupKey).update(JSON.stringify([this.namespace, sid])).digest('hex'); }
  aad(key, agent, expiry) { return Buffer.from(JSON.stringify([this.namespace, key, agent.iss, agent.sub, expiry])); }
  encrypt(key, agent, live) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(this.aad(key, agent, live.accessTokenExpiresAt));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(live)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }
  decrypt(row) {
    const cipher = row.live_ciphertext;
    if (!Buffer.isBuffer(cipher) || cipher.length < 29) throw new Error('Invalid stored credential');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, cipher.subarray(0, 12));
    decipher.setAuthTag(cipher.subarray(12, 28));
    decipher.setAAD(this.aad(row.key, row.agent, Number(row.live_expires_at)));
    const live = JSON.parse(Buffer.concat([decipher.update(cipher.subarray(28)), decipher.final()]).toString());
    if (live.issuer !== row.agent.iss || live.sub !== row.agent.sub || live.accessTokenExpiresAt !== Number(row.live_expires_at) || typeof live.accessToken !== 'string' || !live.accessToken) throw new Error('Invalid stored credential');
    return live;
  }
  async transaction(operation, action, { readOnly = false, finalize } = {}) {
    const client = await this.pool.connect();
    let broken = false, connectionError, committing = false, committed = false;
    const onError = error => { broken = true; connectionError = error; };
    client.on('error', onError);
    try {
      await client.query(`BEGIN ISOLATION LEVEL READ COMMITTED ${readOnly ? 'READ ONLY' : 'READ WRITE'}`);
      await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='5000'; SET LOCAL lock_timeout='3000'; SET LOCAL idle_in_transaction_session_timeout='10000'; SET LOCAL synchronous_commit=on");
      const result = await action(client);
      await this.checkpoint?.({ operation, phase: 'before-commit', client });
      await finalize?.(client);
      if (connectionError) throw connectionError;
      committing = true;
      const commit = await client.query('COMMIT');
      if (commit.command !== 'COMMIT') { committing = false; throw new Error('Transaction rolled back'); }
      committed = true;
      await this.checkpoint?.({ operation, phase: 'after-commit', client });
      if (connectionError) throw connectionError;
      return result;
    } catch (error) {
      if (committing || committed) { broken = true; throw new UncertainCommitError(); }
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.removeListener('error', onError); client.release(broken); }
  }
  async now(client) { return Number((await client.query(`SELECT ${this.table('app_now')}() AS now`)).rows[0].now); }
  async create(sid, agent, live, previousSid) {
    const key = this.key(sid);
    if (sid === previousSid) throw new Error('A new session identifier is required');
    if (!agent || typeof agent.iss !== 'string' || !agent.iss || typeof agent.sub !== 'string' || !agent.sub || typeof agent.handle !== 'string' || !agent.handle || !Array.isArray(agent.scopes) ||
        !live || live.issuer !== agent.iss || live.sub !== agent.sub || typeof live.accessToken !== 'string' || !live.accessToken || !Number.isSafeInteger(live.accessTokenExpiresAt)) throw new Error('Invalid authenticated identity');
    const identity = { iss: agent.iss, sub: agent.sub, handle: agent.handle, scopes: agent.scopes };
    const ciphertext = this.encrypt(key, identity, live);
    let expires;
    return this.transaction('createSession', async client => {
      if (previousSid) await client.query(`DELETE FROM ${this.table('sessions')} WHERE key=$1`, [this.key(previousSid)]);
      const now = await this.now(client);
      if (live.accessTokenExpiresAt <= now) throw new TaskError('reauthentication_required', 401);
      await client.query(`INSERT INTO ${this.table('accounts')}(issuer,subject,first_seen) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [agent.iss, agent.sub, now]);
      expires = now + 3600;
      await client.query(`INSERT INTO ${this.table('sessions')}(key,issuer,subject,agent,expires_at,live_expires_at,live_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)`, [key, agent.iss, agent.sub, identity, expires, live.accessTokenExpiresAt, ciphertext]);
      return { expiresAt: expires };
    }, { finalize: async client => { if (live.accessTokenExpiresAt <= await this.now(client)) throw new TaskError('reauthentication_required', 401); } });
  }
  async row(client, sid, { lock = false, live = false } = {}) {
    const result = await client.query(`SELECT * FROM ${this.table('sessions')} WHERE key=$1${lock ? ' FOR SHARE' : ''}`, [this.key(sid)]);
    const row = result.rows[0], now = await this.now(client);
    if (!row || Number(row.expires_at) <= now) throw new TaskError('not_signed_in', 401);
    if (live && (!row.live_ciphertext || Number(row.live_expires_at) <= now)) throw new TaskError('reauthentication_required', 401);
    return row;
  }
  async get(sid) {
    if (!validSid(sid)) return undefined;
    try {
      return await this.transaction('readSession', async client => {
        const row = await this.row(client, sid);
        const live = row.live_ciphertext && Number(row.live_expires_at) > await this.now(client) ? this.decrypt(row) : undefined;
        return { agent: row.agent, expiresAt: Number(row.expires_at), live };
      }, { readOnly: true });
    } catch (error) { if (error instanceof TaskError && error.status === 401) return undefined; throw error; }
  }
  async logout(sid) {
    if (!validSid(sid)) return;
    await this.transaction('logout', client => client.query(`DELETE FROM ${this.table('sessions')} WHERE key=$1`, [this.key(sid)]));
  }
  async list(sid) {
    return this.transaction('listTasks', async client => {
      const row = await this.row(client, sid);
      return (await client.query(`SELECT id,title,completed,created_at,completed_at FROM ${this.table('tasks')} WHERE issuer=$1 AND subject=$2 ORDER BY created_at DESC,id LIMIT 100`, [row.issuer, row.subject])).rows;
    }, { readOnly: true });
  }
  async write(sid, input, completing = false) {
    validateTask(input, completing);
    return this.transaction(completing ? 'completeTask' : 'createTask', async client => {
      const row = await this.row(client, sid, { lock: true, live: true });
      await client.query(`SELECT subject FROM ${this.table('accounts')} WHERE issuer=$1 AND subject=$2 FOR UPDATE`, [row.issuer, row.subject]);
      await this.checkpoint?.({ operation: completing ? 'completeTask' : 'createTask', phase: 'after-lock', client });
      await this.row(client, sid, { live: true });
      const old = (await client.query(`SELECT id,title,completed,created_at,completed_at FROM ${this.table('tasks')} WHERE issuer=$1 AND subject=$2 AND id=$3`, [row.issuer, row.subject, input.id])).rows[0];
      if (completing) {
        if (!old) throw new TaskError('task_not_found', 404);
        if (old.completed) return old;
        return (await client.query(`UPDATE ${this.table('tasks')} SET completed=true,completed_at=$4 WHERE issuer=$1 AND subject=$2 AND id=$3 RETURNING id,title,completed,created_at,completed_at`, [row.issuer, row.subject, input.id, await this.now(client)])).rows[0];
      }
      if (old) { if (old.title !== input.title) throw new TaskError('idempotency_conflict', 409); return old; }
      if (Number((await client.query(`SELECT count(*) FROM ${this.table('tasks')} WHERE issuer=$1 AND subject=$2`, [row.issuer, row.subject])).rows[0].count) >= 100) throw new TaskError('task_limit', 409);
      return (await client.query(`INSERT INTO ${this.table('tasks')}(issuer,subject,id,title,created_at) VALUES($1,$2,$3,$4,$5) RETURNING id,title,completed,created_at,completed_at`, [row.issuer, row.subject, input.id, input.title, await this.now(client)])).rows[0];
    }, { finalize: client => this.row(client, sid, { live: true }) });
  }
  async cleanup() {
    return this.transaction('cleanup', async client => {
      await client.query(`WITH batch AS (SELECT key FROM ${this.table('sessions')} WHERE live_ciphertext IS NOT NULL AND live_expires_at<=${this.table('app_now')}() ORDER BY live_expires_at LIMIT 500 FOR UPDATE SKIP LOCKED) UPDATE ${this.table('sessions')} s SET live_ciphertext=NULL FROM batch WHERE s.key=batch.key`);
      await client.query(`WITH batch AS (SELECT key FROM ${this.table('sessions')} WHERE expires_at<=${this.table('app_now')}() ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED) DELETE FROM ${this.table('sessions')} s USING batch WHERE s.key=batch.key`);
    });
  }
  async verify() {
    await this.transaction('verify', async client => {
      const versions = (await client.query(`SELECT version FROM ${this.table('schema_version')}`)).rows;
      if (versions.length !== 1 || versions[0].version !== 1) throw new Error('Unsupported application schema');
      if ((await client.query('SELECT pg_is_in_recovery() AS recovery')).rows[0].recovery) throw new Error('Authoritative primary required');
      for (const table of ['accounts', 'sessions', 'tasks']) await client.query(`SELECT 1 FROM ${this.table(table)} LIMIT 0`);
    }, { readOnly: true });
  }
  async migrate() {
    await this.transaction('migrate', async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['agent-tasks/migrate/' + this.schema]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${q(this.schema)}; CREATE TABLE IF NOT EXISTS ${this.table('schema_version')}(version integer PRIMARY KEY)`);
      const versions = (await client.query(`SELECT version FROM ${this.table('schema_version')}`)).rows;
      if (versions.length) { if (versions.length !== 1 || versions[0].version !== 1) throw new Error('Unsupported application schema'); return; }
      await client.query(`CREATE FUNCTION ${this.table('app_now')}() RETURNS bigint LANGUAGE sql VOLATILE SET search_path=pg_catalog AS 'SELECT floor(extract(epoch FROM clock_timestamp()))::bigint';
        CREATE TABLE ${this.table('accounts')}(issuer text NOT NULL,subject text NOT NULL,first_seen bigint NOT NULL,PRIMARY KEY(issuer,subject));
        CREATE TABLE ${this.table('sessions')}(key text PRIMARY KEY,issuer text NOT NULL,subject text NOT NULL,agent jsonb NOT NULL,expires_at bigint NOT NULL,live_expires_at bigint NOT NULL,live_ciphertext bytea,FOREIGN KEY(issuer,subject) REFERENCES ${this.table('accounts')}(issuer,subject));
        CREATE INDEX ON ${this.table('sessions')}(expires_at);
        CREATE INDEX ON ${this.table('sessions')}(live_expires_at) WHERE live_ciphertext IS NOT NULL;
        CREATE TABLE ${this.table('tasks')}(issuer text NOT NULL,subject text NOT NULL,id text NOT NULL,title text NOT NULL,completed boolean NOT NULL DEFAULT false,created_at bigint NOT NULL,completed_at bigint,PRIMARY KEY(issuer,subject,id),FOREIGN KEY(issuer,subject) REFERENCES ${this.table('accounts')}(issuer,subject));
        CREATE INDEX ON ${this.table('tasks')}(issuer,subject,created_at DESC,id);
        INSERT INTO ${this.table('schema_version')}(version) VALUES(1);`);
    });
  }
}
