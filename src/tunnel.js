import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export async function startTunnel(url) {
  console.error('Starting Cloudflare Tunnel…');
  const child = spawn('cloudflared', ['tunnel', '--url', url, '--protocol', 'http2', '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let address;
  let connected = false;
  let stopping = false;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill(); reject(new Error('Cloudflare did not connect the tunnel within 30 seconds.'));
    }, 30_000);
    child.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('cloudflared is required for --tunnel. Install it with: brew install cloudflared'));
    });
    function output(text) {
      if (!address) {
        address = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
        if (address) console.error('Tunnel URL assigned. Connecting to Cloudflare…');
      }
      if (address && !connected && text.includes('Registered tunnel connection')) {
        connected = true;
        clearTimeout(timeout);
        console.error('Cloudflare Tunnel connected.');
        console.error(`\nShare URL: ${address}\n`);
        resolve({ url: address, close: () => { stopping = true; child.kill(); } });
      } else if (!stopping && /ERR|error/i.test(text)) console.error(text.trim());
    }
    createInterface({ input: child.stdout }).on('line', output);
    createInterface({ input: child.stderr }).on('line', output);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (!connected) reject(new Error(`Cloudflare Tunnel exited before connecting, code ${code}.`));
      else if (!stopping && !signal) console.error(`Cloudflare Tunnel stopped with exit code ${code}. The local page is still available.`);
    });
  });
}
