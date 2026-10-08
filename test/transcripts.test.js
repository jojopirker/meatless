import test from 'node:test';
import assert from 'node:assert/strict';
import { codexMessages } from '../src/codex.js';
import { claudeMessages } from '../src/claude.js';

test('Codex publishes conversation text, leaving reasoning and tool output private', () => {
  const messages = codexMessages({ turns: [{ items: [
    { id: '1', type: 'userMessage', content: [{ type: 'text', text: 'A question' }, { type: 'image', url: 'private' }] },
    { id: '2', type: 'reasoning', text: 'Internal reasoning' },
    { id: '3', type: 'commandExecution', aggregatedOutput: 'Sensitive tool output' },
    { id: '4', type: 'agentMessage', text: 'An answer' },
    { id: '5', type: 'userMessage', content: [{ type: 'text', text: '# AGENTS.md instructions\nPrivate owner instructions' }] },
  ] }] });
  assert.deepEqual(messages, [{ id: '1', role: 'user', text: 'A question' }, { id: '4', role: 'assistant', text: 'An answer' }]);
});

test('Claude history includes channel replies and ignores partial writes and subagents', () => {
  const records = [
    { uuid: '1', type: 'user', cwd: '/example', message: { content: 'A question' } },
    { uuid: '2', type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Private' }, { type: 'text', text: 'An answer' }] } },
    { uuid: '3', type: 'user', message: { content: [{ type: 'tool_result', content: 'Sensitive output' }] } },
    { uuid: '4', type: 'assistant', isSidechain: true, message: { content: 'Subagent output' } },
    { uuid: '5', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__meat_proxy__reply', input: { text: 'A channel answer' } }] } },
    { uuid: '6', type: 'user', isMeta: true, message: { content: '<channel source="meat_proxy" sender="Alex">\n[Shared-session message from Alex, collaborator]\n\nA follow-up\n</channel>' } },
    { uuid: '7', type: 'user', isMeta: true, message: { content: 'Private owner instructions' } },
    { type: 'custom-title', customTitle: 'A named session' },
  ];
  const result = claudeMessages(records.map((record) => JSON.stringify(record)).join('\n') + '\n{"unfinished":');
  assert.equal(result.title, 'A named session');
  assert.equal(result.cwd, '/example');
  assert.deepEqual(result.messages, [
    { id: '1', role: 'user', text: 'A question' },
    { id: '2', role: 'assistant', text: 'An answer' },
    { id: '5', role: 'assistant', text: 'A channel answer' },
    { id: '6', role: 'user', text: '[Shared-session message from Alex, collaborator]\n\nA follow-up' },
  ]);
});
