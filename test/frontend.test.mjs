import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
const source = readFileSync(new URL('../public/tasks.js', import.meta.url), 'utf8');
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
function browser(fetch) {
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.disabled = false; this.isConnected = true; this.hidden = false; this.textContent = ''; this.value = ''; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { const detach = item => { item.isConnected = false; item.children.forEach(detach); }; this.children.forEach(detach); this.children = children; }
  }
  const nodes = Object.fromEntries(['status', 'board', 'signin', 'identity', 'tasks', 'empty', 'create-task', 'title', 'logout', 'refresh'].map(id => [id, new Element()]));
  nodes.board.hidden = true;
  const document = { querySelector: selector => nodes[selector.slice(1)], createElement: tag => new Element(tag), querySelectorAll: () => [nodes.title, nodes.logout, nodes.refresh, ...nodes.tasks.children.flatMap(item => item.children.filter(child => child.tag === 'button'))] };
  vm.runInNewContext(source, { document, fetch, crypto: { randomUUID }, AbortSignal });
  return { nodes, submit(title) { nodes.title.value = title; nodes['create-task'].listeners.submit({ preventDefault() {} }); }, click(id) { return nodes[id].listeners.click(); } };
}
for (const lateStatus of [200, 401]) test(`a delayed initial list ${lateStatus} cannot overwrite a newer acknowledged task or session`, async () => {
  const pending = defer(), saved = []; let reads = 0;
  const b = browser(async (path, options) => {
    if (path === '/me') return json({ handle: 'agent@example.com' });
    if (options.method === 'POST') { saved.push(JSON.parse(options.body)); return json({ saved: true }); }
    if (++reads === 1) return pending.promise;
    return json({ tasks: saved });
  });
  await flush(); b.submit('New task'); await flush();
  assert.equal(b.nodes.tasks.children.length, 1); assert.equal(b.nodes.status.textContent, 'Task added.');
  pending.resolve(json(lateStatus === 200 ? { tasks: [] } : { error: 'not_signed_in' }, lateStatus)); await flush();
  assert.equal(b.nodes.tasks.children.length, 1); assert.equal(b.nodes.board.hidden, false); assert.equal(b.nodes.signin.hidden, true);
  assert.equal(b.nodes.status.textContent, 'Task added.');
});
test('uncertain creation keeps its ID/title for an explicit retry and rejects changing the pending request', async () => {
  const posts = []; let fail = true;
  const b = browser(async (path, options) => {
    if (path === '/me') return json({ handle: 'agent@example.com' });
    if (options.method === 'GET') return json({ tasks: [] });
    posts.push(JSON.parse(options.body));
    if (fail) { fail = false; throw new Error('acknowledgement lost'); }
    return json({ saved: true });
  });
  await flush(); b.submit('Original task'); await flush();
  assert.match(b.nodes.status.textContent, /not confirmed/); assert.equal(b.nodes.title.value, 'Original task');
  b.submit('Different task'); await flush(); assert.equal(posts.length, 1); assert.match(b.nodes.status.textContent, /original title/);
  b.submit('Original task'); await flush(); assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1]);
  assert.equal(b.nodes.title.value, '');
});
for (const status of [503, 401]) test(`an acknowledged creation remains successful when its list refresh returns ${status}`, async () => {
  let saved = false, posts = 0;
  const b = browser(async (path, options) => {
    if (path === '/me') return json({ handle: 'agent@example.com' });
    if (options.method === 'POST') { saved = true; posts++; return json({ saved: true }); }
    return saved ? json({ error: 'unavailable' }, status) : json({ tasks: [] });
  });
  await flush(); b.submit('Acknowledged'); await flush();
  assert.equal(posts, 1); assert.equal(b.nodes.title.value, ''); assert.match(b.nodes.status.textContent, /^Task added\./);
  assert.doesNotMatch(b.nodes.status.textContent, /Save was not confirmed/);
});
test('checking saved tasks can reconcile the exact uncertain ID without another write', async () => {
  const saved = []; let posts = 0;
  const b = browser(async (path, options) => {
    if (path === '/me') return json({ handle: 'agent@example.com' });
    if (options.method === 'POST') { posts++; saved.push(JSON.parse(options.body)); throw new Error('reply lost'); }
    return json({ tasks: saved });
  });
  await flush(); b.submit('Already saved'); await flush(); await b.click('refresh'); await flush();
  assert.equal(posts, 1); assert.equal(b.nodes.tasks.children.length, 1); assert.equal(b.nodes.title.value, '');
});
test('a refused invalid creation can be corrected and does not trap the form behind an uncertain draft', async () => {
  let posts = 0;
  const b = browser(async (path, options) => {
    if (path === '/me') return json({ handle: 'agent@example.com' });
    if (options.method === 'GET') return json({ tasks: [] });
    return ++posts === 1 ? json({ error: 'invalid_task' }, 400) : json({ saved: true });
  });
  await flush(); b.submit('Invalid'); await flush(); b.submit('Corrected'); await flush(); assert.equal(posts, 2);
});
