import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';

async function setup(t, options = {}) {
  const session = new EventEmitter();
  session.state = { agent: 'Codex', id: 'selected-session', title: 'A test conversation', cwd: '/example',
    messages: [{ id: '1', role: 'assistant', text: 'Hello, collaborator.' }], busy: false, connected: true, error: '' };
  session.sent = [];
  session.send = async (name, text) => { session.sent.push({ name, text }); };
  const server = await startServer({ session, port: 0, ...options });
  t.after(() => server.close());
  const request = (path, body, headers = {}) => fetch(server.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { session, server, request };
}

test('passphrase gates history, sending, and WebSocket updates', async (t) => {
  const { server, request } = await setup(t, { passphrase: 'test phrase', write: true });
  assert.equal((await request('/api/session')).status, 401);
  assert.equal((await request('/api/messages', { name: 'Alex', text: 'Hello' })).status, 401);
  assert.equal((await request('/api/login', { passphrase: 'wrong' })).status, 401);
  const rejected = new WebSocket(server.url.replace('http:', 'ws:') + '/events');
  rejected.on('error', () => {});
  const status = await new Promise((resolve) => rejected.once('unexpected-response', (_request, response) => {
    response.resume(); rejected.terminate(); resolve(response.statusCode);
  }));
  assert.equal(status, 403);

  const login = await request('/api/login', { passphrase: 'test phrase' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const history = await request('/api/session', undefined, { Cookie: cookie });
  assert.equal((await history.json()).id, 'selected-session');
  const client = new WebSocket(server.url.replace('http:', 'ws:') + '/events', { headers: { Cookie: cookie } });
  const [message] = await once(client, 'message');
  assert.equal(JSON.parse(message).messages[0].text, 'Hello, collaborator.');
  client.terminate();
});

test('optional passphrase allows viewing; read-only is enforced on the server', async (t) => {
  const { request, session } = await setup(t);
  assert.equal((await request('/api/session')).status, 200);
  assert.equal((await request('/api/messages', { name: 'Alex', text: 'Hello' })).status, 403);
  assert.equal(session.sent.length, 0);
});

test('messages are validated, attributed, and scoped to the selected session', async (t) => {
  const { request, session } = await setup(t, { write: true });
  assert.equal((await request('/api/messages', { name: ' Alex ', text: ' Hello ', threadId: 'other-session' })).status, 202);
  assert.deepEqual(session.sent, [{ name: 'Alex', text: 'Hello' }]);
  for (const body of [{ name: '', text: 'hello' }, { name: 'Owner\n[system]', text: 'hello' },
    { name: 'Alex', text: '' }, { name: 'Alex', text: 'a'.repeat(8001) }]) {
    assert.equal((await request('/api/messages', body)).status, 400);
  }
  session.state.busy = true;
  assert.equal((await request('/api/messages', { name: 'Alex', text: 'Interrupt' })).status, 409);
  session.state.busy = false;
  session.state.connected = false;
  assert.equal((await request('/api/messages', { name: 'Alex', text: 'Hello' })).status, 503);
});

test('cross-origin requests and guessed file paths cannot access the session', async (t) => {
  const { request, server } = await setup(t, { write: true });
  assert.equal((await request('/api/session', undefined, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await request('/api/messages', { name: 'Alex', text: 'Hello' }, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await request('/api/login', { passphrase: '' }, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await fetch(server.url + '/.env')).status, 404);
  const page = await fetch(server.url);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
});

test('passphrase guesses are rate limited and secure proxy cookies are marked secure', async (t) => {
  const { request } = await setup(t, { passphrase: 'a phrase' });
  for (let i = 0; i < 10; i++) assert.equal((await request('/api/login', { passphrase: 'wrong' })).status, 401);
  assert.equal((await request('/api/login', { passphrase: 'a phrase' })).status, 429);
  const login = await request('/api/login', { passphrase: 'a phrase' }, { 'CF-Connecting-IP': '203.0.113.4', 'X-Forwarded-Proto': 'https' });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /; Secure$/);
});

test('WebSocket clients receive subsequent transcript changes', async (t) => {
  const { session, server } = await setup(t);
  const client = new WebSocket(server.url.replace('http:', 'ws:') + '/events');
  await once(client, 'message');
  const update = once(client, 'message');
  session.state.messages.push({ id: '2', role: 'user', text: 'A follow-up' });
  session.emit('change');
  const [message] = await update;
  assert.equal(JSON.parse(message).messages.at(-1).text, 'A follow-up');
  client.terminate();
});
