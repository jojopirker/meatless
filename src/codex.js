import { EventEmitter } from 'node:events';
import { connectCodex } from './rpc.js';
import { openCodexTranscript } from './codex-transcript.js';
import { codexTool } from './tool-messages.js';

const isContext = (text) => /^(# AGENTS\.md instructions\b|<user_instructions>|<environment_context>)/.test(text.trimStart());

function conversationItem(item) {
  if (item.type === 'userMessage') {
    const text = item.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    return text && !isContext(text) ? [{ id: item.id, role: 'user', text }] : [];
  }
  if (item.type === 'agentMessage' && item.phase !== 'analysis' && item.text) {
    return [{ id: item.id, role: 'assistant', text: item.text }];
  }
  const tool = codexTool(item);
  return tool ? [tool] : [];
}

export function codexMessages(thread) {
  return (thread.turns ?? []).flatMap((turn) => turn.items.flatMap(conversationItem));
}

export async function listCodexSessions({ connect, cwd } = {}) {
  const rpc = connectCodex(connect);
  return rpc.initialize().then(() => rpc.request('thread/list', {
    limit: 30, modelProviders: [], sortKey: 'updated_at', ...(cwd && { cwd }),
  })).then((result) => result.data.map((thread) => ({
    id: thread.id, title: thread.name || thread.preview || 'Untitled', cwd: thread.cwd,
  }))).finally(() => rpc.close());
}

export async function openCodex({ id, cwd, write, connect, approve, model }) {
  if (!write && !connect) return openCodexTranscript({ id });
  const session = new EventEmitter();
  const rpc = connectCodex(connect);
  const state = { agent: 'Codex', id, title: 'Codex session', cwd: '', messages: [], busy: false, connected: true, error: '' };
  session.state = state;
  const changed = () => session.emit('change');
  let refreshTimer;
  let refreshing = false;

  function updateThread(thread) {
    state.title = thread.name || (thread.preview && !isContext(thread.preview) && thread.preview.slice(0, 100)) || 'Codex session';
    state.cwd = thread.cwd;
    state.messages = codexMessages(thread);
    state.busy = thread.status?.type === 'active';
    changed();
  }

  async function refresh() {
    if (refreshing || !state.connected) return;
    refreshing = true;
    return rpc.request('thread/read', { threadId: state.id, includeTurns: true }).then(({ thread }) => updateThread(thread))
      .finally(() => { refreshing = false; });
  }

  rpc.on('disconnect', (error) => {
    state.connected = false;
    state.error = error;
    changed();
  });
  rpc.on('message', (message) => {
    const { method, params, id: requestId } = message;
    if (params?.threadId && params.threadId !== state.id) return;
    if (requestId !== undefined) {
      // Approvals stay on the owner's terminal, never on the guest page.
      approve(message).then((result) => rpc.write({ id: requestId, result })).catch((error) => {
        console.error(error.message);
        rpc.write({ id: requestId, error: { code: -32603, message: error.message } });
      });
      return;
    }
    if (method === 'item/agentMessage/delta') {
      let item = state.messages.find((entry) => entry.id === params.itemId);
      if (!item) {
        item = { id: params.itemId, role: 'assistant', text: '' };
        state.messages.push(item);
      }
      item.text += params.delta;
      changed();
    }
    if (method === 'item/started' || method === 'item/completed') {
      const [message] = conversationItem(params.item.type === 'webSearch'
        ? { ...params.item, status: method === 'item/started' ? 'inProgress' : 'completed' } : params.item);
      if (!message) return;
      const index = state.messages.findIndex((entry) => entry.id === message.id);
      if (index === -1) state.messages.push(message);
      else state.messages[index] = message;
      changed();
    }
    if (method === 'item/commandExecution/outputDelta') {
      const tool = state.messages.find((entry) => entry.id === params.itemId && entry.role === 'tool');
      if (tool) { tool.output += params.delta; changed(); }
    }
    if (method === 'turn/started') { state.busy = true; changed(); }
    if (method === 'turn/completed') {
      state.busy = false;
      state.error = params.turn.error?.message || '';
      refresh().catch((error) => { state.error = error.message; changed(); });
    }
  });

  await rpc.initialize().catch((error) => { rpc.close(); throw error; });
  const method = id === 'new' ? 'thread/start' : write ? 'thread/resume' : 'thread/read';
  const params = id === 'new' ? { cwd } : { threadId: id, ...(!write && { includeTurns: true }) };
  if (model && write) params.model = model;
  const result = await rpc.request(method, params).catch((error) => { rpc.close(); throw error; });
  state.id = result.thread.id;
  updateThread(result.thread);
  if (!write) refreshTimer = setInterval(() => refresh().catch((error) => {
    state.error = error.message; changed();
  }), 1500);

  session.send = async (name, text) => {
    if (state.busy) throw new Error('Codex is working. Wait for this turn to finish.');
    state.busy = true;
    state.error = '';
    changed();
    return rpc.request('turn/start', {
      threadId: state.id,
      input: [{ type: 'text', text: `[Shared-session message from ${name}, collaborator]\n\n${text}` }],
    }).catch((error) => { state.busy = false; changed(); throw error; });
  };
  session.close = () => { clearInterval(refreshTimer); rpc.close(); };
  return session;
}
