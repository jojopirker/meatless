import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { t3Messages, listT3Sessions, openT3 } from '../src/t3code.js';

const item = (fields) => ({ parentItemId: null, title: null, ...fields });

test('T3 Code history keeps the main chain and drops reasoning, context, and subagent internals', () => {
  const messages = t3Messages([
    item({ id: 'q', type: 'user_message', status: 'completed', text: 'A question', context: { records: [{ text: 'Private owner context' }] }, attachments: [{ id: 'private-image' }] }),
    item({ id: 'think', type: 'reasoning', status: 'completed', text: 'Private reasoning' }),
    item({ id: 'run', type: 'command_execution', status: 'running', title: 'bash', input: 'npm test', output: 'Running…' }),
    item({ id: 'child', type: 'assistant_message', status: 'completed', parentItemId: 'agent', text: 'Subagent output' }),
    item({ id: 'agent', type: 'subagent', status: 'completed', title: 'Research task', prompt: 'Look into retries', result: 'Found the cause' }),
    item({ id: 'todos', type: 'todo_list', status: 'completed', steps: [{ text: 'Private plan' }] }),
    item({ id: 'a', type: 'assistant_message', status: 'completed', text: 'An answer' }),
    item({ id: 'blank', type: 'assistant_message', status: 'completed', text: '' }),
  ]);
  assert.deepEqual(messages, [
    { id: 'q', role: 'user', text: 'A question' },
    { id: 'run', role: 'tool', name: 'Run command', status: 'inProgress', input: 'npm test', output: 'Running…' },
    { id: 'agent', role: 'tool', name: 'Research task', status: 'completed', input: 'Look into retries', output: 'Found the cause' },
    { id: 'a', role: 'assistant', text: 'An answer' },
  ]);
  assert.doesNotMatch(JSON.stringify(messages), /Private|Subagent output|private-image/);
});

test('T3 Code tool rows cover dynamic tools, file changes, and web searches without local paths', () => {
  const messages = t3Messages([
    item({ id: 'tool', type: 'dynamic_tool', status: 'failed', toolName: 'search', input: { query: 'retries' }, output: 'Not found' }),
    item({ id: 'mcp', type: 'dynamic_tool', status: 'waiting', title: 'docs_lookup', input: 'retries', output: '' }),
    item({ id: 'edit', type: 'file_change', status: 'completed', fileName: '/private/project/runner.js', diffStr: '+saveAttempt();' }),
    item({ id: 'web', type: 'web_search', status: 'cancelled', patterns: ['durable retries', 'idempotency'] }),
  ]);
  assert.deepEqual(messages[0], { id: 'tool', role: 'tool', name: 'search', status: 'failed', input: '{\n  "query": "retries"\n}', output: 'Not found' });
  assert.equal(messages[1].name, 'docs_lookup');
  assert.equal(messages[1].status, 'inProgress');
  assert.deepEqual(messages[2], { id: 'edit', role: 'tool', name: 'Edit files', status: 'completed', input: 'runner.js\n+saveAttempt();', output: '' });
  assert.deepEqual(messages[3], { id: 'web', role: 'tool', name: 'Search the web', status: 'failed', input: 'durable retries\nidempotency', output: '' });
  assert.doesNotMatch(JSON.stringify(messages), /private\/project/);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'meatless-t3-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'statev2.sqlite');
  const writer = new DatabaseSync(database);
  t.after(() => writer.close());
  writer.exec(`
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_turn_items (
      turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, parent_item_id TEXT,
      ordinal INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
      updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    INSERT INTO projection_projects VALUES ('project', '/example/project', NULL);
  `);
  const thread = (id, title, updatedAt, archivedAt = null, deletedAt = null) => writer.prepare(
    'INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'project', title, updatedAt, archivedAt, deletedAt, JSON.stringify({ worktreePath: null }));
  const turnItem = (payload, ordinal) => writer.prepare(
    'INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(payload.id, 'thread', payload.parentItemId ?? null, ordinal, payload.type, payload.status, '2026-10-20T00:00:00Z', JSON.stringify(payload));
  thread('thread', 'Shared thread', '2026-10-20T02:00:00Z');
  thread('archived', 'Archived thread', '2026-10-20T03:00:00Z', '2026-10-20T03:00:00Z');
  thread('deleted', 'Deleted thread', '2026-10-20T04:00:00Z', null, '2026-10-20T04:00:00Z');
  turnItem(item({ id: 'q', type: 'user_message', status: 'completed', text: 'A question' }), 2);
  turnItem(item({ id: 'intro', type: 'assistant_message', status: 'completed', text: 'Earlier in order' }), 1);
  return { database, writer, turnItem };
}

test('T3 Code listing returns visible threads with their project directory', async (t) => {
  const { database } = await fixture(t);
  assert.deepEqual(await listT3Sessions(database), [{ id: 'thread', title: 'Shared thread', cwd: '/example/project' }]);
});

test('read-only T3 Code sharing loads a thread in order and follows new items', { timeout: 5000 }, async (t) => {
  const { database, turnItem } = await fixture(t);
  const session = await openT3({ id: 'thread', database });
  t.after(() => session.close());
  assert.equal(session.state.agent, 'T3 Code');
  assert.equal(session.state.title, 'Shared thread');
  assert.deepEqual(session.state.messages.map((message) => message.text), ['Earlier in order', 'A question']);
  assert.equal(session.state.busy, false);
  const changed = once(session, 'change');
  turnItem(item({ id: 'a', type: 'assistant_message', status: 'running', text: 'Streaming answer', streaming: true }), 3);
  await changed;
  assert.equal(session.state.messages.at(-1).text, 'Streaming answer');
  assert.equal(session.state.busy, true);
});

test('the CLI lists T3 Code threads and rejects new or writable T3 Code sessions', { timeout: 8000 }, async (t) => {
  const { database } = await fixture(t);
  const home = join(database, '..', 'home');
  await mkdir(join(home, 'userdata'), { recursive: true });
  await rename(database, join(home, 'userdata', 'statev2.sqlite'));
  const run = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/meatless.js', import.meta.url)), ...args],
      { env: { ...process.env, T3_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
  const listed = await run('list', 't3code');
  assert.equal(listed.code, 0);
  assert.match(listed.output, /^thread {2}Shared thread$/m);
  const created = await run('t3code', 'new', '--write');
  assert.equal(created.code, 1);
  assert.match(created.output, /Start new threads in T3 Code/);
  const writable = await run('t3code', 'thread', '--write');
  assert.equal(writable.code, 1);
  assert.match(writable.output, /T3 Code sharing is read-only for now/);
});

test('T3 Code sharing reports missing data and unknown threads', async (t) => {
  const { database } = await fixture(t);
  await assert.rejects(() => openT3({ id: 'missing', database }), /T3 Code thread not found\. Run: meatless list t3code/);
  await assert.rejects(() => openT3({ id: 'thread', database: join(database, 'absent') }), /T3 Code data was not found/);
  await assert.rejects(() => listT3Sessions(join(database, 'absent')), /T3 Code data was not found/);
});
