const $ = (id) => document.getElementById(id);
let state;
let online = false;
let sending = false;
let socket;
const elements = new Map();
$('name').value = localStorage.getItem('meatless-name') || '';
$('name').addEventListener('change', () => localStorage.setItem('meatless-name', $('name').value));

function updateComposer() {
  $('send').disabled = !online || !state?.connected || state.busy || sending;
  $('send-status').textContent = sending ? 'Sending…' : state?.busy ? 'The agent is working. You can keep drafting.'
    : state?.agent === 'Claude Code' ? 'Messages enter the running session. Claude may group messages while busy.'
    : 'Your message will be attributed to you. Enter to send · Shift+Enter for a new line.';
}

function renderBody(element, text) {
  const parts = text.split(/```[^\n]*\n([\s\S]*?)```/g);
  element.replaceChildren(...parts.map((part, index) => {
    if (index % 2 === 0) return document.createTextNode(part);
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = part.trimEnd();
    pre.append(code);
    return pre;
  }));
}

function render(next) {
  state = next;
  $('gate').hidden = true;
  $('chat').hidden = false;
  $('title').textContent = state.title;
  document.title = `${state.title} · meatless`;
  $('count').textContent = `${state.messages.length} messages`;
  $('message-form').hidden = !state.write;
  $('readonly').hidden = state.write;
  $('session-error').textContent = state.error;
  const transcript = $('transcript');
  const stickToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
  const ids = new Set();
  for (const message of state.messages) {
    ids.add(message.id);
    let element = elements.get(message.id);
    if (!element) {
      element = document.createElement('article');
      element.className = 'message';
      element.dataset.role = message.role;
      const author = document.createElement('div');
      author.className = 'message-author';
      const body = document.createElement('div');
      body.className = 'message-body';
      element.append(author, body);
      elements.set(message.id, element);
      $('messages').append(element);
    }
    if (element.originalText === message.text) continue;
    element.originalText = message.text;
    const text = message.text.match(/^\s*<channel\b[^>]*>([\s\S]*?)<\/channel>\s*$/)?.[1]?.trim() || message.text;
    const guest = text.match(/^\[Shared-session message from (.+), collaborator\]\s*/);
    element.firstChild.textContent = message.role === 'assistant' ? state.agent : guest ? `${guest[1]} · Collaborator` : 'User';
    renderBody(element.lastChild, guest ? text.slice(guest[0].length) : text);
  }
  for (const [id, element] of elements) if (!ids.has(id)) { element.remove(); elements.delete(id); }
  $('empty').hidden = state.messages.length > 0;
  if (stickToBottom) transcript.scrollTop = transcript.scrollHeight;
  updateComposer();
}

async function loadSession() {
  const response = await fetch('/api/session');
  if (response.status === 401) {
    $('chat').hidden = true;
    $('gate').hidden = false;
    $('passphrase').focus();
    return;
  }
  if (!response.ok) throw new Error('Could not load the session.');
  render(await response.json());
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`);
  socket.addEventListener('open', () => { online = true; updateComposer(); });
  socket.addEventListener('message', (event) => render(JSON.parse(event.data)));
  socket.addEventListener('close', () => {
    online = false;
    updateComposer();
    setTimeout(() => loadSession().catch(showError), 1500);
  });
}

function showError(error) { $('session-error').textContent = error.message; }
$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: $('passphrase').value }),
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    $('passphrase').value = '';
    $('login-error').textContent = '';
    await loadSession();
  }).catch((error) => { $('login-error').textContent = error.message; }).finally(() => { button.disabled = false; });
});

$('message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (sending || $('send').disabled) return;
  sending = true;
  updateComposer();
  const text = $('message').value;
  $('session-error').textContent = '';
  fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: $('name').value, text }),
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    if ($('message').value === text) $('message').value = '';
    localStorage.setItem('meatless-name', $('name').value);
    $('message').focus();
    $('transcript').scrollTop = $('transcript').scrollHeight;
  }).catch(showError).finally(() => { sending = false; updateComposer(); });
});
$('message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$('send').disabled) $('message-form').requestSubmit();
  }
});

loadSession().catch(showError);
