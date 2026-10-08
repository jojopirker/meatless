import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';

export function connectCodex(endpoint) {
  const connection = endpoint ? new WebSocket(endpoint)
    : spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const rpc = new EventEmitter();
  const pending = new Map();
  let nextId = 0;

  rpc.write = (message) => endpoint ? connection.send(JSON.stringify(message))
    : connection.stdin.write(JSON.stringify(message) + '\n');
  rpc.request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex did not answer ${method} within 30 seconds.`));
    }, 30_000);
    pending.set(id, { resolve, reject, timeout });
    rpc.write({ id, method, params });
  });

  function receive(line) {
    const message = JSON.parse(line);
    if (message.method) {
      rpc.emit('message', message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  }
  if (endpoint) connection.on('message', receive);
  else createInterface({ input: connection.stdout }).on('line', receive);

  function disconnect(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
    rpc.emit('disconnect', error.message);
  }
  connection.on('error', disconnect);
  connection.on(endpoint ? 'close' : 'exit', () => disconnect(new Error('Codex connection closed.')));
  if (!endpoint) connection.stdin.on('error', () => {}); // The child exit reports a broken pipe.
  rpc.close = () => endpoint ? connection.close() : connection.kill();
  rpc.initialize = async () => {
    if (endpoint) await new Promise((resolve, reject) => {
      connection.once('open', resolve);
      connection.once('error', reject);
    });
    await rpc.request('initialize', {
      clientInfo: { name: 'agent_share', title: 'agent-share', version: '0.1.0' },
    });
    rpc.write({ method: 'initialized' });
  };
  return rpc;
}
