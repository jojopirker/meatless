import { EventEmitter } from 'node:events';
import { glob, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { codexTool, toolMessage } from './tool-messages.js';

const sessionRoot = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');

function savedTool(item, completed) {
  const status = item.status === 'in_progress' ? 'inProgress' : item.status;
  switch (item.type) {
    case 'CommandExecution':
      return codexTool({ type: 'commandExecution', id: item.id, status,
        command: item.command.join(' '), aggregatedOutput: item.aggregated_output });
    case 'McpToolCall':
      return codexTool({ ...item, type: 'mcpToolCall' });
    case 'DynamicToolCall':
      return codexTool({ ...item, type: 'dynamicToolCall', status, contentItems: item.content_items });
    case 'WebSearch':
      return codexTool({ ...item, type: 'webSearch', status: completed ? 'completed' : 'inProgress' });
    case 'FileChange':
      return toolMessage(item.id, 'Edit files', status ?? (completed ? 'completed' : 'inProgress'),
        Object.entries(item.changes).map(([path, change]) => `${basename(path)}\n${JSON.stringify(change, null, 2)}`).join('\n\n'),
        [item.stdout, item.stderr].filter(Boolean).join('\n'));
  }
}

export function codexTranscript(contents) {
  const lines = contents.slice(0, contents.lastIndexOf('\n')).split('\n').filter(Boolean);
  const messages = new Map();
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record.type !== 'event_msg' || !['item_started', 'item_completed'].includes(record.payload.type)) continue;
    const { item } = record.payload;
    const tool = savedTool(item, record.payload.type === 'item_completed');
    if (tool) { messages.set(tool.id, tool); continue; }
    if (record.payload.type !== 'item_completed') continue;
    const role = item.type === 'UserMessage' ? 'user' : item.type === 'AgentMessage' ? 'assistant' : undefined;
    if (!role || item.phase === 'analysis') continue;
    const text = item.content.filter((part) => part.type === (role === 'user' ? 'text' : 'Text'))
      .map((part) => part.text).join('\n');
    if (!text || /^(# AGENTS\.md instructions\b|<user_instructions>|<environment_context>)/.test(text.trimStart())) continue;
    messages.set(item.id, { id: item.id, role, text });
  }
  return [...messages.values()];
}

export async function openCodexTranscript({ id, root = sessionRoot }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Expected a Codex session ID.');
  const paths = await Array.fromAsync(glob(`**/*-${id}.jsonl`, { cwd: root }));
  const path = paths[0] && join(root, paths[0]);
  if (!path) throw new Error('Codex session not found on this machine.');
  const session = new EventEmitter();
  session.state = { agent: 'Codex', id, title: 'Codex session', messages: [], busy: false, connected: true, error: '' };
  let lastSize = -1;
  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    return stat(path).then(async ({ size }) => {
      if (size === lastSize) return;
      const contents = await readFile(path, 'utf8');
      lastSize = Buffer.byteLength(contents);
      session.state.messages = codexTranscript(contents);
      session.state.title = session.state.messages.find((message) => message.role === 'user')?.text.slice(0, 100) || 'Codex session';
      session.state.error = '';
      session.emit('change');
    }).finally(() => { refreshing = false; });
  }
  await refresh();
  const timer = setInterval(() => refresh().catch((error) => {
    session.state.error = error.message; session.emit('change');
  }), 1000);
  session.close = () => clearInterval(timer);
  return session;
}
