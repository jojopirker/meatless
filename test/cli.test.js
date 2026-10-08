import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('a bare Codex deep link loads its history and starts a tunnel automatically', { timeout: 8000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'meat-proxy-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex');
  await mkdir(join(home, 'sessions'), { recursive: true });
  const id = '12345678-1234-1234-1234-123456789abc';
  const record = { type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'UserMessage', id: 'first', content: [{ type: 'text', text: 'The selected conversation' }],
  } } };
  await writeFile(join(home, 'sessions', `rollout-${id}.jsonl`), JSON.stringify(record) + '\n');
  const argsPath = join(directory, 'tunnel-args.json');
  await writeFile(join(directory, 'cloudflared'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.TEST_TUNNEL_ARGS, JSON.stringify(process.argv.slice(2)));
console.error('https://synthetic-test.trycloudflare.com');
console.error('Registered tunnel connection');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  // The temporary executable uses ES modules, just like the CLI.
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/meat-proxy.js', import.meta.url)),
    `codex://threads/${id}`, '--port', String(port)], { env: {
      ...process.env, CODEX_HOME: home, MEAT_PROXY_PASSPHRASE: '',
      PATH: directory + ':' + process.env.PATH, TEST_TUNNEL_ARGS: argsPath,
    }, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  let output = '';
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`CLI exited with ${code}: ${output}`)));
    child.stderr.on('data', (chunk) => {
      output += chunk;
      if (output.includes('Share URL: https://synthetic-test.trycloudflare.com')) resolve();
    });
  });
  const history = await fetch(`http://127.0.0.1:${port}/api/session`).then((response) => response.json());
  assert.equal(history.id, id);
  assert.equal(history.messages[0].text, 'The selected conversation');
  assert.equal(history.write, false);
  assert.equal(Object.hasOwn(history, 'cwd'), false);
  const tunnelArgs = JSON.parse(await readFile(argsPath, 'utf8'));
  assert.equal(tunnelArgs[tunnelArgs.indexOf('--url') + 1], `http://127.0.0.1:${port}`);
});
