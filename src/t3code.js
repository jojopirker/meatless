import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { toolMessage } from './tool-messages.js';

// node:sqlite is built in, but Node still flags it experimental on load.
// Keep that warning out of the sharing terminal.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if ((typeof warning === 'object' ? warning.name : rest[0]) !== 'ExperimentalWarning') {
    emitWarning.call(process, warning, ...rest);
  }
};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

// T3 Code keeps every thread in a local SQLite projection, whatever provider
// (Codex, Claude, Muse, …) produced it. Sharing reads that store, so no
// second agent runtime is started and T3 Code can keep running.
export const t3Database = join(process.env.T3_HOME || join(homedir(), '.t3'), 'userdata', 'statev2.sqlite');

const statuses = {
  pending: 'inProgress', starting: 'inProgress', running: 'inProgress', waiting: 'inProgress',
  completed: 'completed', failed: 'failed', cancelled: 'failed', interrupted: 'failed',
};
const status = (value) => statuses[value] ?? 'failed';

function turnItem(item) {
  if (item.parentItemId) return; // Subagent internals stay out, like Claude sidechains.
  switch (item.type) {
    case 'user_message':
      return item.text ? { id: item.id, role: 'user', text: item.text } : undefined;
    case 'assistant_message':
      return item.text ? { id: item.id, role: 'assistant', text: item.text } : undefined;
    case 'command_execution':
      return toolMessage(item.id, 'Run command', status(item.status), item.input ?? '', item.output ?? '');
    case 'dynamic_tool':
      return toolMessage(item.id, item.toolName || item.title || 'Tool', status(item.status), item.input ?? '', item.output ?? '');
    case 'file_change':
      return toolMessage(item.id, 'Edit files', status(item.status), `${basename(item.fileName ?? '')}\n${item.diffStr ?? ''}`);
    case 'web_search':
      return toolMessage(item.id, 'Search the web', status(item.status), (item.patterns ?? []).join('\n'));
    case 'subagent':
      return toolMessage(item.id, item.title || 'Subagent', status(item.status), item.prompt ?? '', item.result ?? '');
  }
}

// Reasoning, checkpoints, plans, approvals, owner context records, and
// attachments are not types or fields this reads, so they never reach guests.
export function t3Messages(items) {
  return items.map(turnItem).filter(Boolean);
}

function openDatabase(database) {
  if (!existsSync(database)) {
    throw new Error(`T3 Code data was not found at ${database}. Open T3 Code on this machine first.`);
  }
  // Read-only, so a running T3 Code stays the only writer; its WAL is readable.
  return new DatabaseSync(database, { readOnly: true });
}

export async function listT3Sessions(database = t3Database) {
  const store = openDatabase(database);
  try {
    return store.prepare(`
      SELECT thread.thread_id AS id, thread.title, thread.payload_json AS payload, project.workspace_root AS cwd
      FROM orchestration_v2_projection_threads AS thread
      LEFT JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE thread.deleted_at IS NULL AND thread.archived_at IS NULL
      ORDER BY thread.updated_at DESC LIMIT 30
    `).all().map(({ payload, ...session }) => ({
      ...session, cwd: JSON.parse(payload).worktreePath || session.cwd || '',
    }));
  } finally {
    store.close();
  }
}

export async function openT3({ id, database = t3Database }) {
  const store = openDatabase(database);
  const session = new EventEmitter();
  const state = { agent: 'T3 Code', id, title: 'T3 Code thread', messages: [], busy: false, connected: true, error: '' };
  session.state = state;
  const thread = store.prepare(`
    SELECT title FROM orchestration_v2_projection_threads
    WHERE thread_id = ? AND deleted_at IS NULL
  `);
  const items = store.prepare(`
    SELECT payload_json AS payload FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ? ORDER BY ordinal, turn_item_id
  `);
  const activity = store.prepare(`
    SELECT count(*) AS total, max(updated_at) AS latest FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ?
  `);
  if (!thread.get(id)) {
    store.close();
    throw new Error('T3 Code thread not found. Run: meatless list t3code');
  }
  let fingerprint = '';
  function refresh() {
    const current = thread.get(id);
    const { total, latest } = activity.get(id);
    const next = `${current?.title}:${total}:${latest}`;
    if (next === fingerprint) return;
    fingerprint = next;
    const parsed = items.all(id).map((row) => JSON.parse(row.payload));
    state.title = current?.title || 'T3 Code thread';
    state.messages = t3Messages(parsed);
    state.busy = parsed.some((entry) => status(entry.status) === 'inProgress');
    state.error = '';
    session.emit('change');
  }
  try {
    refresh();
  } catch (error) {
    store.close();
    throw error;
  }
  const timer = setInterval(() => {
    try {
      refresh();
    } catch (error) {
      state.error = error.message;
      session.emit('change');
    }
  }, 1000);
  session.close = () => { clearInterval(timer); store.close(); };
  return session;
}
