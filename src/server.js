import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const hash = (text) => createHash('sha256').update(text).digest();

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 32_000) throw Object.assign(new Error('Message too large.'), { status: 413 });
  }
  return JSON.parse(body);
}

export async function startServer({ session, port = 8787, passphrase = '', write = false }) {
  const tokens = new Set();
  const attempts = new Map();
  const passwordHash = hash(passphrase);
  const files = new Map(await Promise.all([...assets].map(async ([path, [file, contentType]]) => [
    path, { contentType, body: await readFile(new URL(`../public/${file}`, import.meta.url)) },
  ])));
  const snapshot = () => ({ ...session.state, write });
  const authenticated = (request) => !passphrase || tokens.has(
    request.headers.cookie?.match(/(?:^|;\s*)agent_share=([a-f0-9]+)/)?.[1],
  );
  const sameOrigin = (request) => !request.headers.origin
    || ['http', 'https'].some((scheme) => request.headers.origin === `${scheme}://${request.headers.host}`);
  const json = (response, status, body) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

  async function route(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const path = request.url.split('?')[0];
    if (!sameOrigin(request)) return json(response, 403, { error: 'Cross-origin requests are not allowed.' });
    if (request.method === 'GET' && files.has(path)) {
      const file = files.get(path);
      response.writeHead(200, { 'Content-Type': file.contentType }).end(file.body);
      return;
    }
    if (request.method === 'GET' && path === '/api/access') return json(response, 200, { passphrase: Boolean(passphrase) });
    if (request.method === 'POST' && path === '/api/login') {
      const ip = request.headers['cf-connecting-ip'] || request.socket.remoteAddress;
      const now = Date.now();
      const attempt = attempts.get(ip);
      if (attempt && attempt.until > now && attempt.count >= 10) {
        response.setHeader('Retry-After', '60');
        return json(response, 429, { error: 'Too many attempts. Try again in a minute.' });
      }
      const body = await readBody(request);
      if (typeof body.passphrase !== 'string' || !timingSafeEqual(hash(body.passphrase), passwordHash)) {
        attempts.set(ip, { count: attempt?.until > now ? attempt.count + 1 : 1, until: now + 60_000 });
        return json(response, 401, { error: 'Incorrect passphrase.' });
      }
      attempts.delete(ip);
      const token = randomBytes(32).toString('hex');
      tokens.add(token);
      const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      response.setHeader('Set-Cookie', `agent_share=${token}; HttpOnly; SameSite=Strict; Path=/${secure}`);
      return json(response, 200, { ok: true });
    }
    if (!authenticated(request)) return json(response, 401, { error: 'Enter the passphrase to join.' });
    if (request.method === 'GET' && path === '/api/session') return json(response, 200, snapshot());
    if (request.method === 'POST' && path === '/api/messages') {
      if (!write) return json(response, 403, { error: 'This session is read-only.' });
      if (!session.state.connected) return json(response, 503, { error: 'The agent is disconnected.' });
      if (session.state.busy) return json(response, 409, { error: 'The agent is working. Wait for this turn to finish.' });
      const { name, text } = await readBody(request);
      if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\r\n\[\]<>]/.test(name)) {
        return json(response, 400, { error: 'Enter a name of up to 80 characters without brackets or newlines.' });
      }
      if (typeof text !== 'string' || !text.trim() || text.length > 8000) {
        return json(response, 400, { error: 'Enter a message of up to 8,000 characters.' });
      }
      await session.send(name.trim(), text.trim());
      return json(response, 202, { ok: true });
    }
    json(response, 404, { error: 'Not found.' });
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error) => {
      const status = error.status || (error instanceof SyntaxError ? 400 : 500);
      if (status === 500) console.error(error.message);
      if (!response.headersSent) json(response, status, { error: status === 400 ? 'Invalid JSON.' : error.message });
      else response.end();
    });
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/events' || !authenticated(request) || !sameOrigin(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      client.on('error', () => client.terminate());
      client.on('message', () => client.close(1008, 'Use the messages endpoint.'));
      client.send(JSON.stringify(snapshot()));
    });
  });
  let previous = '';
  function broadcast() {
    const data = JSON.stringify(snapshot());
    if (data === previous) return;
    previous = data;
    for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
  }
  session.on('change', broadcast);
  const heartbeat = setInterval(() => {
    for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) client.ping();
  }, 20_000);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch((error) => { clearInterval(heartbeat); session.off('change', broadcast); throw error; });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      clearInterval(heartbeat);
      session.off('change', broadcast);
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
