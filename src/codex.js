import { EventEmitter } from 'node:events';
import { connectCodex } from './rpc.js';

export function codexMessages(thread) {
  return (thread.turns ?? []).flatMap((turn) => turn.items.flatMap((item) => {
    if (item.type === 'userMessage') {
      const text = item.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      return text ? [{ id: item.id, role: 'user', text }] : [];
    }
    if (item.type === 'agentMessage' && item.text) {
      return [{ id: item.id, role: 'assistant', text: item.text }];
    }
    return [];
  }));
}

export async function listCodexSessions({ socket, cwd } = {}) {
  const rpc = connectCodex(socket);
  return rpc.initialize().then(() => rpc.request('thread/list', {
    limit: 30, modelProviders: [], sortKey: 'updated_at', ...(cwd && { cwd }),
  })).then((result) => result.data.map((thread) => ({
    id: thread.id, title: thread.name || thread.preview || 'Untitled', cwd: thread.cwd,
  }))).finally(() => rpc.close());
}

export async function openCodex({ id, cwd, write, socket, approve }) {
  const session = new EventEmitter();
  const rpc = connectCodex(socket);
  const state = { agent: 'Codex', id, title: 'Codex session', cwd: '', messages: [], busy: false, connected: true, error: '' };
  session.state = state;
  const changed = () => session.emit('change');
  let refreshTimer;
  let refreshing = false;

  async function refresh() {
    if (refreshing || !state.connected) return;
    refreshing = true;
    return rpc.request('thread/read', { threadId: state.id, includeTurns: true }).then(({ thread }) => {
      state.title = thread.name || thread.preview?.slice(0, 100) || 'Codex session';
      state.cwd = thread.cwd;
      state.messages = codexMessages(thread);
      state.busy = thread.status?.type === 'active';
      changed();
    }).finally(() => { refreshing = false; });
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
    if (method === 'item/started' && params.item.type === 'userMessage') {
      const text = params.item.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      if (!state.messages.some((entry) => entry.id === params.item.id)) {
        state.messages.push({ id: params.item.id, role: 'user', text });
      }
      changed();
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
  const params = id === 'new' ? { cwd } : { threadId: id, ...(write ? {} : { includeTurns: true }) };
  const result = await rpc.request(method, params).catch((error) => { rpc.close(); throw error; });
  state.id = result.thread.id;
  await refresh();
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
