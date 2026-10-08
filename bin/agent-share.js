#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCodexSessions, openCodex } from '../src/codex.js';
import { claudeSessionFiles, claudeMessages, listClaudeSessions, openClaudeChannel } from '../src/claude.js';
import { readFile } from 'node:fs/promises';
import { startServer } from '../src/server.js';
import { startTunnel } from '../src/tunnel.js';

const help = `Usage:
  agent-share list codex|claude [--cwd <directory>]
  agent-share codex <session-id>|new [options]
  agent-share claude <session-id>|new [options]

Options:
  --write          Let guests send attributed messages. Default: read-only.
  --passphrase     Prompt for a passphrase before starting.
  --tunnel         Start a temporary Cloudflare Tunnel and print its URL.
  --port <port>    Local port. Default: 8787.
  --cwd <path>     Working directory for a new session or session listing.
  --socket <path>  Connect to a running Codex app-server control socket.
  --help          Show this help.

Set AGENT_SHARE_PASSPHRASE instead of --passphrase for non-interactive use.
Codex: use --socket for a live server. Otherwise, --write resumes the session
in this process; use the shared page instead of the original Codex window.
Claude: resumes the conversation with the sharing channel enabled. Close the
original Claude session first. Tool approvals remain in your terminal.
`;

async function ask(question, secret = false) {
  if (!process.stdin.isTTY) throw new Error('A terminal is required for this prompt. Use AGENT_SHARE_PASSPHRASE for a passphrase.');
  console.error(question);
  const output = secret ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stderr;
  const input = createInterface({ input: process.stdin, output, terminal: true });
  return input.question('').finally(() => { input.close(); if (secret) console.error(''); });
}

let approvalQueue = Promise.resolve();
function approve(message) {
  approvalQueue = approvalQueue.then(async () => {
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
      console.error(`\nCodex requests approval: ${message.params.command || message.params.reason || message.method}`);
      const answer = process.stdin.isTTY ? await ask('Approve? [y/N]') : 'n';
      return { decision: answer.toLowerCase() === 'y' ? 'accept' : 'decline' };
    }
    if (message.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (message.method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
    throw new Error(`This version cannot answer ${message.method}. Continue that action in Codex.`);
  });
  return approvalQueue;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    write: { type: 'boolean', default: false }, passphrase: { type: 'boolean', default: false },
    tunnel: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    port: { type: 'string', default: '8787' }, cwd: { type: 'string' }, socket: { type: 'string' },
  } });
  const [command, argument] = positionals;
  if (values.help || !command) { console.error(help); return; }
  const options = { ...values, port: Number(values.port), cwd: resolve(values.cwd || process.cwd()) };
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Port must be between 1 and 65535.');
  if (command === 'list') {
    if (!['codex', 'claude'].includes(argument)) throw new Error('Choose list codex or list claude.');
    const sessions = argument === 'codex'
      ? await listCodexSessions({ socket: options.socket, cwd: values.cwd && options.cwd })
      : await listClaudeSessions();
    for (const session of sessions.filter((entry) => !values.cwd || entry.cwd === options.cwd)) {
      console.log(`${session.id}  ${session.title.replace(/\s+/g, ' ').slice(0, 90)}\n  ${session.cwd}`);
    }
    if (!sessions.length) console.error('No sessions found. Start one with: agent-share ' + argument + ' new --write');
    return;
  }
  if (!['codex', 'claude', 'claude-channel'].includes(command) || !argument) throw new Error(help);
  options.id = argument === 'new' && command !== 'codex' ? randomUUID() : argument;
  if (argument === 'new' && !options.write) throw new Error('Use --write when starting a new session.');
  let passphrase = process.env.AGENT_SHARE_PASSPHRASE || '';
  if (values.passphrase) {
    passphrase = await ask('Passphrase:', true);
    if (!passphrase) throw new Error('The passphrase cannot be empty.');
  }

  if (command === 'claude') {
    if (argument !== 'new') {
      const path = claudeSessionFiles().find((file) => file.endsWith(`/${argument}.jsonl`));
      if (!path) throw new Error('Claude session not found. Run: agent-share list claude');
      options.cwd = values.cwd ? options.cwd : claudeMessages(await readFile(path, 'utf8')).cwd;
    }
    const channelArgs = [fileURLToPath(import.meta.url), 'claude-channel', options.id, '--port', String(options.port), '--cwd', options.cwd];
    if (options.write) channelArgs.push('--write');
    if (options.tunnel) channelArgs.push('--tunnel');
    const config = JSON.stringify({ mcpServers: { agent_share: { command: process.execPath, args: channelArgs } } });
    const args = [argument === 'new' ? '--session-id' : '--resume', options.id, '--mcp-config', config,
      '--dangerously-load-development-channels', 'server:agent_share', '--allowedTools', 'mcp__agent_share__reply'];
    console.error('Starting Claude with the sharing channel. Accept its development-channel prompt to connect.');
    const child = spawn('claude', args, { cwd: options.cwd, stdio: 'inherit', env: { ...process.env, AGENT_SHARE_PASSPHRASE: passphrase } });
    child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code) => { process.exitCode = code || 0; });
    return;
  }

  const session = command === 'codex'
    ? await openCodex({ ...options, approve })
    : await openClaudeChannel(options);
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

main().catch((error) => { console.error(`agent-share: ${error.message}`); process.exitCode = 1; });
