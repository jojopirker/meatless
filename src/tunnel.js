import { spawn } from 'node:child_process';

export async function startTunnel(url) {
  const child = spawn('cloudflared', ['tunnel', '--url', url, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new Error('cloudflared is required for --tunnel. Install it with: brew install cloudflared')));
  });
  let announced = false;
  function output(chunk) {
    const address = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (address && !announced) { announced = true; console.error(`\nShare URL: ${address[0]}\n`); }
    else if (/ERR|error/i.test(chunk.toString())) console.error(chunk.toString().trim());
  }
  child.stdout.on('data', output);
  child.stderr.on('data', output);
  child.on('exit', (code, signal) => {
    if (!signal) console.error(`Cloudflare Tunnel stopped with exit code ${code}. The local page is still available.`);
  });
  return { close: () => child.kill() };
}
