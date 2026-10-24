import { createServer } from 'node:http';

/** A bounded Node HTTP to WHATWG adapter. Never trusts forwarded hosts or absolute request targets. */
export function httpServer(base, fetch) {
  const server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 10_000, connectionsCheckingInterval: 1000, keepAliveTimeout: 5_000 }, async (incoming, outgoing) => {
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//') || incoming.url.length > 8192) { outgoing.writeHead(400); outgoing.end(); return; }
      const controller = new AbortController();
      incoming.once('aborted', () => controller.abort());
      const chunks = []; let size = 0;
      // Do not use unlimited text/body readers; the server timeout also bounds slow uploads.
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 8192) { outgoing.writeHead(413, { connection: 'close', 'cache-control': 'no-store' }); outgoing.end(); incoming.resume(); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      const request = new Request(base + incoming.url, { method: incoming.method, headers, signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(incoming.method) && size ? { body: Buffer.concat(chunks), duplex: 'half' } : {}) });
      const response = await fetch(request);
      for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
      const cookies = response.headers.getSetCookie(); if (cookies.length) outgoing.setHeader('set-cookie', cookies);
      outgoing.statusCode = response.status;
      const body = Buffer.from(await response.arrayBuffer());
      outgoing.end(incoming.method === 'HEAD' ? undefined : body);
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end('{"error":"service_unavailable"}');
    }
  });
  server.maxHeadersCount = 40;
  server.maxRequestsPerSocket = 1000;
  // Keep Node's default parser-error and timeout response followed by socket destruction.
  // Merely socket.end() would leave an allowHalfOpen peer occupying a server connection.
  return server;
}
