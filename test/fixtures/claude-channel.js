import { openClaudeChannel } from '../../src/claude.js';
import { startServer } from '../../src/server.js';

const session = await openClaudeChannel({ id: process.argv[3], root: process.argv[2], cwd: '/example' });
const server = await startServer({ session, port: 0, write: true });
console.error(server.url);
session.once('end', () => { session.close(); server.close(); });
