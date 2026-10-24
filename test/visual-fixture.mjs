// Local visual QA only. Never included in the production Docker image.
import { randomBytes } from 'node:crypto';
import { MemoryCallbackStateStore } from '@agentlogin/rp';
import { createApplication } from '../src/app.mjs';
import { httpServer } from '../src/http.mjs';
if (process.env.NODE_ENV === 'production') throw new Error('Visual fixture is development only');
const base = 'http://127.0.0.1:50341', cookie = randomBytes(32).toString('base64url');
const tasks = new Map([['visual-fixture-0001', { id: 'visual-fixture-0001', title: 'Review the onboarding guide', completed: false }], ['visual-fixture-0002', { id: 'visual-fixture-0002', title: 'Confirm callback replay is rejected', completed: true }]]);
let active = true;
const store = {
  verify: async () => {},
  get: async id => active && id === cookie ? { agent: { iss: 'https://identity.sentfrom.ai', sub: 'visual-fixture', handle: 'preview@mail.sentfrom.ai', scopes: ['openid', 'email'] }, live: {} } : undefined,
  list: async () => [...tasks.values()],
  write: async (_sid, input, completing) => { const task = completing ? { ...tasks.get(input.id), completed: true } : { ...input, completed: false }; tasks.set(input.id, task); return task; },
  logout: async () => { active = false; },
};
const app = createApplication({ base, issuer: 'https://identity.sentfrom.ai', stateSecret: 'visual-fixture-state-secret'.repeat(2), allowLoopback: true, store, callbackStore: new MemoryCallbackStateStore(), recheck: async () => {} });
const server = httpServer(base, async request => {
  if (new URL(request.url).pathname === '/demo-session') { active = true; return new Response(null, { status: 303, headers: { location: '/tasks-board', 'set-cookie': `agent_tasks_sid=${cookie}; Path=/; HttpOnly; SameSite=Lax` } }); }
  return app.fetch(request);
});
server.listen(50341, '127.0.0.1', () => console.log('Local visual fixture: ' + base));
process.once('SIGTERM', () => { server.close(); server.closeAllConnections(); });
process.once('SIGINT', () => { server.close(); server.closeAllConnections(); });
