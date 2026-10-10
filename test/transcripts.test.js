import test from 'node:test';
import assert from 'node:assert/strict';
import { codexMessages } from '../src/codex.js';
import { claudeMessages } from '../src/claude.js';

test('Codex excludes reasoning, owner context, and unsupported items', () => {
  const messages = codexMessages({ turns: [{ items: [
    { id: '1', type: 'userMessage', content: [{ type: 'text', text: 'A question' }, { type: 'image', url: 'private' }] },
    { id: '2', type: 'reasoning', text: 'Internal reasoning' },
    { id: '3', type: 'unknown', text: 'Unsupported item' },
    { id: 'analysis', type: 'agentMessage', phase: 'analysis', text: 'Private analysis' },
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
    { uuid: '5', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__meatless__reply', input: { text: 'A channel answer' } }] } },
    { uuid: '6', type: 'user', isMeta: true, message: { content: '<channel source="meatless" sender="Alex">\n[Shared-session message from Alex, collaborator]\n\nA follow-up\n</channel>' } },
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

test('Codex tool rows include input and text output without reasoning or image payloads', () => {
  const messages = codexMessages({ turns: [{ items: [
    { id: 'command', type: 'commandExecution', command: 'npm test', cwd: '/private/project', status: 'failed', aggregatedOutput: 'One test failed', exitCode: 1 },
    { id: 'mcp', type: 'mcpToolCall', server: 'docs', tool: 'search', arguments: { query: 'retries' }, status: 'completed',
      result: { content: [{ type: 'text', text: 'Documentation' }, { type: 'image', data: 'private-image' }] } },
    { id: 'dynamic', type: 'dynamicToolCall', tool: 'lookup', arguments: {}, status: 'completed',
      contentItems: [{ type: 'inputText', text: 'Found it' }, { type: 'inputImage', imageUrl: 'private-image' }] },
    { id: 'edit', type: 'fileChange', status: 'completed', changes: [{ path: '/private/project/runner.js', kind: { type: 'update' }, diff: '+saveAttempt();' }] },
    { id: 'search', type: 'webSearch', query: 'durable retries', action: null },
    { id: 'error', type: 'mcpToolCall', server: 'docs', tool: 'search', arguments: {}, status: 'failed', error: { message: 'Not found' } },
  ] }] });
  assert.deepEqual(messages[0], { id: 'command', role: 'tool', name: 'Run command', status: 'failed', input: 'npm test', output: 'One test failed' });
  assert.equal(messages[1].output, 'Documentation');
  assert.equal(messages[1].input, '{\n  "query": "retries"\n}');
  assert.equal(messages[2].output, 'Found it');
  assert.equal(messages[3].input, 'runner.js\n+saveAttempt();');
  assert.equal(messages[4].input, 'durable retries');
  assert.equal(messages[4].status, 'completed');
  assert.equal(messages[5].output, 'Not found');
  assert.doesNotMatch(JSON.stringify(messages), /private-image|private\/project/);
});

test('Claude pairs parallel tool results by ID and preserves text around calls', () => {
  const records = [
    { uuid: 'a', type: 'assistant', message: { content: [
      { type: 'text', text: 'I will check.' },
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'runner.js' } },
      { type: 'text', text: 'And run the tests.' },
      { type: 'tool_use', id: 'test', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', id: 'pending', name: 'Read', input: { file_path: 'README.md' } },
    ] } },
    { uuid: 'b', type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'test', is_error: true, content: 'Test failed' },
      { type: 'tool_result', tool_use_id: 'read', content: [{ type: 'text', text: 'File contents' }, { type: 'image', source: { data: 'private-image' } }] },
      { type: 'tool_result', tool_use_id: 'unknown', content: 'Orphan output' },
    ] } },
    { uuid: 'c', type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'private', name: 'Private', input: {} }] } },
  ];
  const { messages } = claudeMessages(records.map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual(messages.map((message) => message.role), ['assistant', 'tool', 'assistant', 'tool', 'tool']);
  assert.equal(messages[1].output, 'File contents');
  assert.equal(messages[1].status, 'completed');
  assert.equal(messages[2].text, 'And run the tests.');
  assert.equal(messages[3].output, 'Test failed');
  assert.equal(messages[3].status, 'failed');
  assert.equal(messages[4].status, 'inProgress');
  assert.equal(new Set(messages.map((message) => message.id)).size, 5);
  assert.doesNotMatch(JSON.stringify(messages), /private-image|Orphan output|Private/);
});
