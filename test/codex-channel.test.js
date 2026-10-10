import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { openCodex } from '../src/codex.js';

test('a fresh Codex thread starts without a rollout and streams a collaborator turn', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let client;
  let turnInput;
  let reads = 0;
  const thread = { id: 'shared-thread', cwd: '/example', turns: [], status: { type: 'idle' } };
  server.on('connection', (socket) => {
    client = socket;
    socket.on('message', (data) => {
      const { id, method, params } = JSON.parse(data);
      if (id === undefined) return;
      let result = {};
      if (method === 'thread/start') {
        assert.equal(params.model, 'test-model');
        result = { thread };
      }
      if (method === 'thread/read') {
        reads++;
        if (!thread.turns.length) {
          socket.send(JSON.stringify({ id, error: { message: 'no rollout until the first turn' } }));
          return;
        }
        result = { thread };
      }
      if (method === 'turn/start') { turnInput = params.input; result = { turn: { id: 'first-turn' } }; }
      socket.send(JSON.stringify({ id, result }));
    });
  });
  t.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const session = await openCodex({ id: 'new', cwd: '/example', write: true,
    connect: `ws://127.0.0.1:${server.address().port}`, model: 'test-model' });
  t.after(() => session.close());
  assert.equal(session.state.id, thread.id);
  assert.deepEqual(session.state.messages, []);
  assert.equal(reads, 0);
  await session.send('Alex', 'Use the existing context.');
  assert.equal(session.state.busy, true);
  assert.match(turnInput[0].text, /^\[Shared-session message from Alex, collaborator\]\n\nUse the existing context\.$/);
  const notify = (method, params) => client.send(JSON.stringify({ method, params: { threadId: thread.id, ...params } }));
  const command = { id: 'command', type: 'commandExecution', command: 'npm test', status: 'inProgress', aggregatedOutput: '' };
  let changed = once(session, 'change');
  notify('item/started', { item: command });
  await changed;
  assert.equal(session.state.messages[0].status, 'inProgress');
  changed = once(session, 'change');
  notify('item/commandExecution/outputDelta', { itemId: 'command', delta: 'Tests passed' });
  await changed;
  assert.equal(session.state.messages[0].output, 'Tests passed');
  changed = once(session, 'change');
  const completedCommand = { ...command, status: 'completed', aggregatedOutput: 'Tests passed\nDone' };
  notify('item/completed', { item: completedCommand });
  await changed;
  assert.equal(session.state.messages.length, 1);
  assert.equal(session.state.messages[0].status, 'completed');
  assert.equal(session.state.messages[0].output, 'Tests passed\nDone');
  changed = once(session, 'change');
  notify('item/agentMessage/delta', { itemId: 'answer', delta: 'A streamed answer' });
  await changed;
  assert.equal(session.state.messages[1].text, 'A streamed answer');
  thread.turns = [{ items: [
    { id: 'question', type: 'userMessage', content: turnInput },
    completedCommand,
    { id: 'answer', type: 'agentMessage', text: 'A streamed answer' },
  ] }];
  changed = once(session, 'change');
  notify('turn/completed', { turn: { id: 'first-turn', error: null } });
  await changed;
  assert.equal(session.state.busy, false);
  assert.equal(reads, 1);
  assert.deepEqual(session.state.messages.map((message) => message.role), ['user', 'tool', 'assistant']);
});
