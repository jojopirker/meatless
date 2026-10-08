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

test('desktop Codex history includes conversation items and excludes private context and tools', () => {
  const contents = [
    completed(question), completed(answer), completed(answer),
    completed({ type: 'UserMessage', id: 'context', content: [{ type: 'text', text: '# AGENTS.md instructions\nPrivate owner context' }] }),
    completed({ type: 'Reasoning', id: 'reasoning', raw_content: 'Private reasoning' }),
    completed({ type: 'CommandExecution', id: 'tool', aggregated_output: 'Private command output' }),
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
