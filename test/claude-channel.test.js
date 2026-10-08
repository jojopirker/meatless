import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('Claude channel sends attributed notifications and delivers replies through the real MCP transport', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'meatless-channel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'));
  const id = '12345678-1234-1234-1234-123456789abc';
  const path = join(root, 'project', id + '.jsonl');
  const record = { uuid: 'first', type: 'user', cwd: '/example', message: { content: 'Existing context' } };
  await writeFile(path, JSON.stringify(record) + '\n');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/claude-channel.js', import.meta.url)), root, id], stderr: 'pipe' });
  let resolveURL;
  const urlReady = new Promise((resolve) => { resolveURL = resolve; });
  const client = new Client({ name: 'test-claude', version: '1.0.0' });
  const connected = client.connect(transport);
  transport.stderr.on('data', (chunk) => {
    const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) resolveURL(match[0]);
  });
  t.after(() => client.close());
  await connected;
  const url = await urlReady;
  assert.deepEqual(client.getServerCapabilities().experimental, { 'claude/channel': {} });
  const history = await fetch(url + '/api/session').then((response) => response.json());
  assert.equal(history.messages[0].text, 'Existing context');
  let resolveNotification;
  const received = new Promise((resolve) => { resolveNotification = resolve; });
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === 'notifications/claude/channel') resolveNotification(notification);
  };
  const response = await fetch(url + '/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alex', text: 'What does the existing context mean?' }) });
  assert.equal(response.status, 202);
  const notification = await received;
  assert.equal(notification.params.meta.sender, 'Alex');
  assert.match(notification.params.content, /^\[Shared-session message from Alex, collaborator\]/);
  assert.equal((await client.listTools()).tools[0].name, 'reply');
  await client.callTool({ name: 'reply', arguments: { text: 'Here is an answer using the existing context.' } });
  const updated = await fetch(url + '/api/session').then((response) => response.json());
  assert.equal(updated.messages.at(-1).text, 'Here is an answer using the existing context.');
});
