import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RelyingParty, RelyingPartyError, createHandlers, signInForm, signInFormCss } from '@agentlogin/rp';
import { TaskError, validSid, validateTask } from './store.mjs';

const script = readFileSync(new URL('../public/tasks.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8') + signInFormCss;
const escape = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function exactOrigin(value, allowLoopback = false) {
  const url = new URL(value);
  if (value !== url.origin || url.username || url.password || (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Expected an exact HTTPS origin');
  return value;
}
const json = (value, status = 200, headers) => Response.json(value, { status, headers });
export async function bodyJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new TaskError('expected_json', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new TaskError('invalid_json', 400);
  let bytes = 0, timedOut = false; const chunks = [];
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 5_000);
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 8192) throw new TaskError('body_too_large', 413); chunks.push(next.value); }
    if (timedOut) throw new TaskError('body_timeout', 408);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new TaskError('invalid_json', 400); }
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createApplication({ base, issuer, stateSecret, store, callbackStore, allowLoopback = false, testHandleDomains = [], ready = () => store.verify().then(() => true), recheck }) {
  exactOrigin(base, allowLoopback); exactOrigin(issuer, allowLoopback);
  if (!stateSecret || stateSecret.length < 32) throw new Error('State secret required');
  const dev = base.startsWith('http:');
  if (testHandleDomains.length && !dev) throw new Error('Static discovery overrides are only allowed on loopback');
  const cookieName = dev ? 'agent_tasks_sid' : '__Host-agent_tasks_sid';
  const cookie = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${dev ? '' : '; Secure'}`;
  const session = request => {
    const values = (request.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(cookieName + '='));
    const value = values.length === 1 ? values[0].slice(cookieName.length + 1) : undefined;
    return validSid(value) ? value : undefined;
  };
  const rp = new RelyingParty({ clientId: base + '/client-metadata.json', redirectUri: base + '/auth/agent/callback', issuers: [issuer], scopes: ['openid', 'email'], stateSecret, allowInsecure: dev, staticIssuers: Object.fromEntries(testHandleDomains.map(domain => [domain, issuer])) });
  const check = recheck ?? (live => rp.recheck(live));
  const auth = createHandlers(rp, {
    callbackStore,
    metadata: { clientName: 'Agent Tasks', initiateLoginUri: base + '/auth/agent/login', policyUri: base + '/privacy', tosUri: base + '/terms' },
    log: () => {}, // The host emits only generic status metrics, never protocol messages or full URLs.
    onSignIn: async (signIn, request) => {
      const sid = randomBytes(32).toString('base64url');
      await store.create(sid, signIn.agent, rp.liveCheckOf(signIn), session(request));
      return new Response(null, { status: 303, headers: { location: '/tasks-board', 'set-cookie': cookie(sid, 3600) } });
    },
  });
  const page = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Tasks</title><link rel="stylesheet" href="/style.css"><script src="/tasks.js" defer></script></head><body><main><header><a class="brand" href="/">Agent Tasks</a><span class="badge">Developer beta</span></header><section class="hero"><p class="eyebrow">A small place to get things done</p><h1>Your agent.<br>Your task list.</h1><p>Sign in with your agent identity. Create private tasks, finish them, and pick up where you left off.</p></section><section id="signin" class="card"><h2>Sign in with Agent</h2>${signInForm({ action: '/auth/agent/login' })}<p class="hint">Using an assistant? Give it <code>${escape(base)}/auth/agent/login</code>. Its session stays in its own helper.</p></section><section id="board" class="card" hidden><div class="board-heading"><div><h2>Your tasks</h2><p id="identity" class="hint"></p></div><div class="board-actions"><button id="refresh" class="secondary">Check saved tasks</button><button id="logout" class="secondary">Sign out</button></div></div><form id="create-task"><label for="title">New task</label><div class="task-input"><input id="title" name="title" maxlength="200" required placeholder="What needs doing?"><button>Add task</button></div></form><ul id="tasks"></ul><p id="empty" class="hint">No tasks yet. Add your first one.</p></section><p id="status" role="status" aria-live="polite"></p><footer><a href="/privacy">Privacy</a><a href="/terms">Beta terms</a><span>Accepts SentFrom.ai identities. Up to 100 tasks per agent.</span></footer></main></body></html>`;
  const info = (title, text) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} - Agent Tasks</title><link rel="stylesheet" href="/style.css"></head><body><main><a class="brand" href="/">Agent Tasks</a><section class="card"><h1>${title}</h1><p>${text}</p></section></main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  async function route(request) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    if (url.origin !== base) return json({ error: 'invalid_host' }, 400);
    if (['/tasks', '/tasks/complete', '/logout'].includes(path) && method === 'POST') {
      if (request.headers.get('origin') !== base || (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) return json({ error: 'same_origin_required' }, 403);
    }
    if (method === 'GET' && ['/me', '/tasks'].includes(path) && ((request.headers.has('origin') && request.headers.get('origin') !== base) || (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin'))) return json({ error: 'same_origin_required' }, 403);
    if (method === 'GET' && path === '/healthz') return json({ status: 'alive' });
    if (method === 'GET' && path === '/readyz') { try { if (await ready()) return json({ status: 'ready' }); } catch {} return json({ status: 'unavailable' }, 503); }
    if (method === 'GET' && path === '/client-metadata.json') return auth.metadata(request);
    if (['GET', 'POST'].includes(method) && path === '/auth/agent/login') return auth.login(request);
    if (method === 'GET' && path === '/auth/agent/callback') return auth.callback(request);
    if (method === 'GET' && ['/', '/tasks-board'].includes(path)) return new Response(page(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (method === 'GET' && path === '/tasks.js') return new Response(script, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    if (method === 'GET' && path === '/style.css') return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8' } });
    if (method === 'GET' && path === '/privacy') return info('Privacy', 'Agent Tasks stores your provider and immutable agent identifier, handle, tasks, and session records. It does not request your Owner email or profile. Access tokens are encrypted and retained only for their short lifetime. Tasks remain until the beta operator processes account deletion. Use synthetic or non-sensitive content in this beta. Contact your named beta operator for access or deletion requests.');
    if (method === 'GET' && path === '/terms') return info('Beta terms', 'This invite-only developer beta is provided for evaluation without a production availability guarantee. You remain responsible for what your agent creates. Each agent may keep up to 100 tasks. Do not store secrets or regulated data. Access may be suspended during maintenance or an incident. Your invitation identifies the operator and support route.');
    const sid = session(request);
    if (method === 'POST' && path === '/logout') { await store.logout(sid); return json({ signed_out: true }, 200, { 'set-cookie': cookie('', 0) }); }
    if ((method === 'GET' && ['/me', '/tasks'].includes(path)) || (method === 'POST' && ['/tasks', '/tasks/complete'].includes(path))) {
      const current = sid && await store.get(sid);
      if (!current) return json({ error: 'not_signed_in' }, 401);
      if (method === 'GET' && path === '/me') return json(current.agent);
      if (method === 'GET') return json({ tasks: await store.list(sid) });
      const input = await bodyJson(request);
      validateTask(input, path === '/tasks/complete');
      if (!current.live) return json({ error: 'reauthentication_required' }, 401);
      try { await check(current.live); }
      catch (error) {
        if (error instanceof RelyingPartyError && ['revoked', 'reauthentication_required'].includes(error.code)) { await store.logout(sid); return json({ error: error.code }, 401); }
        return json({ error: 'issuer_unavailable' }, 503);
      }
      return json({ saved: true, task: await store.write(sid, input, path === '/tasks/complete') });
    }
    return json({ error: 'not_found' }, 404);
  }
  return {
    rp,
    async fetch(request) {
      let response;
      try { response = await route(request); }
      catch (error) { response = error instanceof TaskError ? json({ error: error.code }, error.status) : json({ error: 'service_unavailable' }, 503); }
      const headers = new Headers(response.headers);
      headers.set('cache-control', 'no-store, private');
      headers.set('referrer-policy', 'no-referrer');
      headers.set('x-content-type-options', 'nosniff');
      headers.set('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      if (!dev) headers.set('strict-transport-security', 'max-age=31536000');
      return new Response(response.body, { status: response.status, headers });
    },
  };
}
