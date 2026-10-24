import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { test } from 'node:test';
import { httpServer } from '../src/http.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const kind of ['malformed-request', 'incomplete-body']) test(`Node destroys ${kind} half-open connections`, { timeout: 5000 }, async t => {
  const server = httpServer('http://127.0.0.1', () => Response.json({ ok: true }));
  if (kind === 'incomplete-body') { server.requestTimeout = 100; server.headersTimeout = 100; }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const socket = new Socket({ allowHalfOpen: true }); let received = '';
  socket.on('data', chunk => { received += chunk.toString(); }); socket.on('error', () => {});
  t.after(() => socket.destroy());
  await new Promise(resolve => socket.connect(server.address().port, '127.0.0.1', resolve));
  socket.write(kind === 'malformed-request' ? 'BOGUS HTTP\r\n\r\n' : 'POST /tasks HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\na');
  const deadline = Date.now() + 3000;
  const status = kind === 'malformed-request' ? /400 Bad Request/ : /408 Request Timeout/;
  let count = 1;
  // The server can destroy its side before the client's data event delivers the buffered response.
  do { await delay(25); count = await new Promise((resolve, reject) => server.getConnections((error, n) => error ? reject(error) : resolve(n))); } while ((count || !status.test(received)) && Date.now() < deadline);
  assert.equal(count, 0, 'bad clients cannot retain a server connection after an error response');
  assert.match(received, status);
});
