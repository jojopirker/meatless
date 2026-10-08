import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export function connectCodex(socket) {
  const args = socket
    ? ['app-server', 'proxy', '--sock', socket]
    : ['app-server'];
  const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const rpc = new EventEmitter();
  const pending = new Map();
  let nextId = 0;

  rpc.write = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  rpc.request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex did not answer ${method} within 30 seconds.`));
    }, 30_000);
    pending.set(id, { resolve, reject, timeout });
    rpc.write({ id, method, params });
  });

  createInterface({ input: child.stdout }).on('line', (line) => {
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
  });

  function disconnect(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
    rpc.emit('disconnect', error.message);
  }
  child.on('error', disconnect);
  child.on('exit', () => disconnect(new Error('Codex connection closed.')));
  child.stdin.on('error', () => {}); // The child exit reports a broken pipe.
  rpc.close = () => child.kill();
  rpc.initialize = async () => {
    await rpc.request('initialize', {
      clientInfo: { name: 'agent_share', title: 'agent-share', version: '0.1.0' },
    });
    rpc.write({ method: 'initialized' });
  };
  return rpc;
}
