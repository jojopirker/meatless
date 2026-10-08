# agent-share

Share one local Codex or Claude Code conversation through a small web chat.

The first version uses Node.js, plain browser JavaScript, and Cloudflare Tunnel.
Guests can read the selected conversation. Enable writing to let them send
messages with their name attached. An optional passphrase protects access.

Codex connects through its app-server protocol. Claude Code connects through
an MCP channel. Conversation history stays in the agent's existing storage.
