import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexTranscript, openCodexTranscript } from '../src/codex-transcript.js';

const completed = (item) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item } }) + '\n';
const question = { type: 'UserMessage', id: 'question', content: [{ type: 'text', text: 'A saved question' }] };
const answer = { type: 'AgentMessage', id: 'answer', phase: 'final_answer', content: [{ type: 'Text', text: 'A saved answer' }] };

test('desktop Codex history excludes private context, reasoning, and unsupported items', () => {
  const contents = [
    completed(question), completed(answer), completed(answer),
    completed({ type: 'UserMessage', id: 'context', content: [{ type: 'text', text: '# AGENTS.md instructions\nPrivate owner context' }] }),
    completed({ type: 'Reasoning', id: 'reasoning', raw_content: 'Private reasoning' }),
    completed({ type: 'Unknown', id: 'other', text: 'Unsupported item' }),
    completed({ ...answer, id: 'analysis', phase: 'analysis', content: [{ type: 'Text', text: 'Private analysis' }] }),
    '{"unfinished":',
  ].join('');
  assert.deepEqual(codexTranscript(contents), [
    { id: 'question', role: 'user', text: 'A saved question' },
    { id: 'answer', role: 'assistant', text: 'A saved answer' },
  ]);
});

test('read-only Codex sharing loads the selected saved session and follows new messages', { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'meatless-codex-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '2026', '10', '08');
  await mkdir(directory, { recursive: true });
  const id = '12345678-1234-1234-1234-123456789abc';
  const path = join(directory, `rollout-2026-10-08T20-00-00-${id}.jsonl`);
  await writeFile(path, completed(question));
  const session = await openCodexTranscript({ id, root });
  t.after(() => session.close());
  assert.equal(session.state.messages[0].text, 'A saved question');
  assert.equal(session.state.title, 'A saved question');
  const changed = once(session, 'change');
  await appendFile(path, completed(answer));
  await changed;
  assert.equal(session.state.messages.at(-1).text, 'A saved answer');
});

test('saved Codex tool lifecycles update in place among conversation messages', () => {
  const command = { type: 'CommandExecution', id: 'command', command: ['npm', 'test'], status: 'in_progress' };
  const started = (item) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_started', item } }) + '\n';
  const contents = completed(question) + started(command) + completed(answer)
    + completed({ ...command, status: 'completed', aggregated_output: 'All tests passed' })
    + completed({ type: 'McpToolCall', id: 'mcp', server: 'docs', tool: 'search', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: 'Found docs' }] } })
    + completed({ type: 'DynamicToolCall', id: 'dynamic', tool: 'lookup', arguments: {}, status: 'failed', content_items: [{ type: 'inputText', text: 'Not found' }] })
    + completed({ type: 'FileChange', id: 'edit', status: 'completed', changes: { '/private/project/runner.js': { type: 'update', unified_diff: '+saveAttempt();' } }, stdout: 'Applied' })
    + started({ type: 'WebSearch', id: 'search', query: 'retries', action: { type: 'search', query: 'retries' } });
  const messages = codexTranscript(contents);
  assert.deepEqual(messages.map((message) => message.id), ['question', 'command', 'answer', 'mcp', 'dynamic', 'edit', 'search']);
  assert.deepEqual(messages[1], { id: 'command', role: 'tool', name: 'Run command', status: 'completed', input: 'npm test', output: 'All tests passed' });
  assert.equal(messages[3].output, 'Found docs');
  assert.equal(messages[4].status, 'failed');
  assert.equal(messages[4].output, 'Not found');
  assert.match(messages[5].input, /^runner.js\n/);
  assert.equal(messages[5].output, 'Applied');
  assert.equal(messages[6].status, 'inProgress');
  assert.doesNotMatch(JSON.stringify(messages), /private\/project/);
});
