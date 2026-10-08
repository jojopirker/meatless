#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCodexSessions, openCodex } from '../src/codex.js';
import { claudeSessionFiles, claudeMessages, listClaudeSessions, openClaudeChannel, openClaudeTranscript } from '../src/claude.js';
import { readFile } from 'node:fs/promises';
import { startServer } from '../src/server.js';
import { startTunnel } from '../src/tunnel.js';

const help = `Usage:
  meatless codex://threads/<session-id> [options]
  meatless list codex|claude [--cwd <directory>]
  meatless codex <session-id>|new [options]
  meatless claude <session-id>|new [options]

Options:
  --write          Let guests send attributed messages. Default: read-only.
  --passphrase     Prompt for a passphrase before starting.
  --tunnel         Start a temporary Cloudflare Tunnel. Automatic for deep links.
  --local          Use only localhost, without a tunnel.
  --port <port>    Local port. Default: 8787.
  --cwd <path>     Working directory for a new session or session listing.
  --connect <url>  Connect to a running Codex app-server WebSocket URL.
  --model <name>   Override the Codex model for this session.
  --help          Show this help.

Set MEATLESS_PASSPHRASE instead of --passphrase for non-interactive use.
Codex: use --connect for a live server. Otherwise, --write resumes the session
in this process; use the shared page instead of the original Codex window.
Claude: read-only sharing watches the existing transcript. With --write,
close the original Claude session first; this command resumes it with the
sharing channel enabled. Tool approvals remain in your terminal.
`;

async function ask(question, secret = false) {
  if (!process.stdin.isTTY) throw new Error('A terminal is required for this prompt. Use MEATLESS_PASSPHRASE for a passphrase.');
  console.error(question);
  const output = secret ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stderr;
  const input = createInterface({ input: process.stdin, output, terminal: true });
  return input.question('').finally(() => { input.close(); if (secret) console.error(''); });
}

let approvalQueue = Promise.resolve();
function approve(message) {
  const result = approvalQueue.then(async () => {
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
      console.error(`\nCodex requests approval: ${message.params.command || message.params.reason || message.method}`);
      const answer = process.stdin.isTTY ? await ask('Approve? [y/N]') : 'n';
      return { decision: answer.toLowerCase() === 'y' ? 'accept' : 'decline' };
    }
    if (message.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (message.method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
    throw new Error(`This version cannot answer ${message.method}. Continue that action in Codex.`);
  });
  approvalQueue = result.catch(() => {}); // One unsupported prompt must not block later approvals.
  return result;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    write: { type: 'boolean', default: false }, passphrase: { type: 'boolean', default: false },
    tunnel: { type: 'boolean', default: false }, local: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    port: { type: 'string', default: '8787' }, cwd: { type: 'string' }, connect: { type: 'string' }, model: { type: 'string' },
  } });
  let [command, argument] = positionals;
  if (values.help || !command) { console.error(help); return; }
  const deepLink = command.startsWith('codex:') || argument?.startsWith('codex:');
  if (deepLink) {
    const link = new URL(command.startsWith('codex:') ? command : argument);
    if (link.protocol !== 'codex:' || link.hostname !== 'threads' || !/^\/[0-9a-f-]{36}$/i.test(link.pathname)) {
      throw new Error('Expected codex://threads/<session-id>.');
    }
    command = 'codex';
    argument = link.pathname.slice(1);
  }
  const options = { ...values, port: Number(values.port), cwd: resolve(values.cwd || process.cwd()) };
  options.tunnel = !values.local && (values.tunnel || Boolean(deepLink));
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Port must be between 1 and 65535.');
  if (command === 'list') {
    if (!['codex', 'claude'].includes(argument)) throw new Error('Choose list codex or list claude.');
    const sessions = argument === 'codex'
      ? await listCodexSessions({ connect: options.connect, cwd: values.cwd && options.cwd })
      : await listClaudeSessions();
    for (const session of sessions.filter((entry) => !values.cwd || entry.cwd === options.cwd)) {
      console.log(`${session.id}  ${session.title.replace(/\s+/g, ' ').slice(0, 90)}\n  ${session.cwd}`);
    }
    if (!sessions.length) console.error('No sessions found. Start one with: meatless ' + argument + ' new --write');
    return;
  }
  if (!['codex', 'claude', 'claude-channel'].includes(command) || !argument) throw new Error(help);
  options.id = argument === 'new' && command !== 'codex' ? randomUUID() : argument;
  if (argument === 'new' && !options.write) throw new Error('Use --write when starting a new session.');
  let passphrase = process.env.MEATLESS_PASSPHRASE || '';
  if (values.passphrase) {
    passphrase = await ask('Passphrase:', true);
    if (!passphrase) throw new Error('The passphrase cannot be empty.');
  }

  if (command === 'claude') {
    if (argument !== 'new') {
      const path = claudeSessionFiles().find((file) => file.endsWith(`/${argument}.jsonl`));
      if (!path) throw new Error('Claude session not found. Run: meatless list claude');
      options.cwd = values.cwd ? options.cwd : claudeMessages(await readFile(path, 'utf8')).cwd;
    }
  }
  if (command === 'claude' && options.write) {
    const channelArgs = [fileURLToPath(import.meta.url), 'claude-channel', options.id, '--port', String(options.port), '--cwd', options.cwd];
    if (options.write) channelArgs.push('--write');
    const config = JSON.stringify({ mcpServers: { meatless: { command: process.execPath, args: channelArgs } } });
    const args = [argument === 'new' ? '--session-id' : '--resume', options.id, '--mcp-config', config,
      '--dangerously-load-development-channels', 'server:meatless', '--allowedTools', 'mcp__meatless__reply'];
    const localURL = `http://127.0.0.1:${options.port}`;
    console.error(`\nLocal URL: ${localURL}\nSession: ${options.id}\n`);
    const tunnel = options.tunnel ? await startTunnel(localURL) : undefined;
    console.error('Starting Claude with the sharing channel. Accept its development-channel prompt to connect.');
    const child = spawn('claude', args, { cwd: options.cwd, stdio: 'inherit', env: { ...process.env, MEATLESS_PASSPHRASE: passphrase } });
    child.once('error', (error) => { tunnel?.close(); console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code) => { tunnel?.close(); process.exitCode = code || 0; });
    process.once('SIGTERM', () => { child.kill('SIGTERM'); tunnel?.close(); });
    return;
  }

  const session = command === 'codex' ? await openCodex({ ...options, approve })
    : command === 'claude' ? await openClaudeTranscript(options) : await openClaudeChannel(options);
  const server = await startServer({ ...options, session, passphrase }).catch((error) => {
    session.close(); throw error;
  });
  console.error(`\n${session.state.agent} · ${options.write ? 'read and write' : 'read-only'} · ${passphrase ? 'passphrase required' : 'anyone with the URL can join'}\nLocal URL: ${server.url}\nSession: ${session.state.id}\n`);
  let tunnel;
  if (options.tunnel) tunnel = await startTunnel(server.url).catch((error) => {
    server.close(); session.close(); throw error;
  });
  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    tunnel?.close();
    session.close();
    server.close().then(() => { process.exitCode = 0; });
  }
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  session.once('end', close);
}

main().catch((error) => { console.error(`meatless: ${error.message}`); process.exitCode = 1; });
