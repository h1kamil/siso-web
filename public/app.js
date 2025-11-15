// app.js
// Läuft im Browser.
// - generiert User-ID (pro Gerät/Browser)
// - zeigt Invite-Link & QR-Code
// - ruft das Backend (server.js) auf
// - holt Chats, Nachrichten
// - löscht Nachrichten nach erstem Klick (1-View)

// ---------- User-ID & Short-ID ----------

function getOrCreateUserId() {
  let id = localStorage.getItem('siso_user_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('siso_user_id', id);
  }
  return id;
}

function getShortId(fullId) {
  return fullId.slice(0, 8);
}

const myUserId = getOrCreateUserId();
const myShortId = getShortId(myUserId);

// ---------- DOM-Elemente ----------

const myIdSpan = document.getElementById('my-id');
const myShortIdSpan = document.getElementById('my-short-id');
const inviteLinkInput = document.getElementById('invite-link');
const copyLinkBtn = document.getElementById('copy-link-btn');

const otherIdInput = document.getElementById('other-id-input');
const addChatBtn = document.getElementById('add-chat-btn');

const chatListUl = document.getElementById('chat-list');
const chatInfoDiv = document.getElementById('chat-info');
const reloadMessagesBtn = document.getElementById('reload-messages-btn');
const messageListUl = document.getElementById('message-list');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');

const qrcodeCanvas = document.getElementById('qrcode');

// ---------- Zustand im Browser ----------

let chats = [];           // Liste aller Chats
let messagesByChat = {};  // chatId -> Array von Nachrichten
let activeChatId = null;

// ---------- Anzeige der eigenen ID & Invite-Link ----------

myIdSpan.textContent = myUserId;
myShortIdSpan.textContent = myShortId;

const inviteLink = `${window.location.origin}/#${myUserId}`;
inviteLinkInput.value = inviteLink;

// QR-Code rendern
if (window.QRCode) {
  QRCode.toCanvas(qrcodeCanvas, inviteLink, { width: 200 }, (error) => {
    if (error) console.error(error);
  });
}

// ---------- API-Helfer ----------

async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} fehlgeschlagen: ${res.status} ${text}`);
  }
  return res.json();
}

async function apiPost(path, bodyObj) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} fehlgeschlagen: ${res.status} ${text}`);
  }
  return res.json();
}

// ---------- Chats ----------

async function loadChats() {
  const data = await apiGet(`/api/chats?userId=${encodeURIComponent(myUserId)}`);
  chats = data;
  renderChatList();
  if (!activeChatId && chats.length > 0) {
    setActiveChat(chats[0].id);
  }
}

async function ensureChat(otherUserId) {
  const res = await apiPost('/api/chats', {
    myUserId,
    otherUserId,
  });
  const chatId = res.chatId;
  await loadChats();
  setActiveChat(chatId);
}

function getActiveChat() {
  if (!activeChatId) return null;
  return chats.find((c) => c.id === activeChatId) || null;
}

function setActiveChat(chatId) {
  activeChatId = chatId;
  renderChatList();
  renderChatInfo();
  renderMessages();
}

// ---------- Nachrichten ----------

// vom Server holen (für aktiven Chat)
async function loadMessagesForActiveChat() {
  const chat = getActiveChat();
  if (!chat) return;
  const msgs = await apiGet(
    `/api/messages?chatId=${encodeURIComponent(chat.id)}&userId=${encodeURIComponent(myUserId)}`
  );
  messagesByChat[chat.id] = msgs;
  renderMessages();
}

// Nachricht senden
async function sendMessage() {
  const chat = getActiveChat();
  if (!chat) {
    alert('Bitte zuerst einen Chat auswählen oder anlegen.');
    return;
  }
  const text = messageInput.value.trim();
  if (!text) return;

  const otherId = chat.userAId === myUserId ? chat.userBId : chat.userAId;

  await apiPost('/api/messages', {
    chatId: chat.id,
    senderId: myUserId,
    receiverId: otherId,
    content: text,
  });

  messageInput.value = '';

  // eigene Nachricht lokal anzeigen (sie wird NICHT vom Server zurückgegeben)
  if (!messagesByChat[chat.id]) {
    messagesByChat[chat.id] = [];
  }
  messagesByChat[chat.id].push({
    id: crypto.randomUUID(), // nur lokale Anzeige-ID
    chatId: chat.id,
    senderId: myUserId,
    receiverId: otherId,
    content: text,
    createdAt: Date.now(),
    localOnly: true,
  });
  renderMessages();
}

// Nachricht wurde angeklickt (1-View -> löschen)
async function onMessageClicked(msg) {
  const chat = getActiveChat();
  if (!chat) return;

  if (!msg.localOnly) {
    try {
      await apiPost(`/api/messages/${encodeURIComponent(msg.id)}/view`, {});
    } catch (e) {
      console.error('Fehler beim Löschen der Nachricht:', e);
    }
  }

  const arr = messagesByChat[chat.id] || [];
  messagesByChat[chat.id] = arr.filter((m) => m.id !== msg.id);
  renderMessages();
}

// ---------- Rendering ----------

function renderChatList() {
  chatListUl.innerHTML = '';
  chats.forEach((chat) => {
    const li = document.createElement('li');
    const otherId = chat.userAId === myUserId ? chat.userBId : chat.userAId;
    li.textContent = `Chat mit: ${getShortId(otherId)}…`;
    if (chat.id === activeChatId) {
      li.classList.add('active');
    }
    li.addEventListener('click', () => setActiveChat(chat.id));
    chatListUl.appendChild(li);
  });
}

function renderChatInfo() {
  const chat = getActiveChat();
  if (!chat) {
    chatInfoDiv.textContent = 'Kein Chat ausgewählt.';
    return;
  }
  const otherId = chat.userAId === myUserId ? chat.userBId : chat.userAId;
  chatInfoDiv.textContent = `Chat mit User: ${otherId} (Kurz: ${getShortId(otherId)}…)`;
}

function renderMessages() {
  const chat = getActiveChat();
  messageListUl.innerHTML = '';
  if (!chat) return;
  const arr = messagesByChat[chat.id] || [];
  arr.forEach((msg) => {
    const li = document.createElement('li');
    const isMe = msg.senderId === myUserId;
    li.classList.add(isMe ? 'msg-me' : 'msg-other', 'msg-text');
    li.textContent = `👁️ ${msg.content}`;
    li.addEventListener('click', () => onMessageClicked(msg));
    messageListUl.appendChild(li);
  });
}

// ---------- Events ----------

copyLinkBtn.addEventListener('click', () => {
  inviteLinkInput.select();
  document.execCommand('copy');
  alert('Invite-Link in die Zwischenablage kopiert.');
});

addChatBtn.addEventListener('click', async () => {
  const otherId = otherIdInput.value.trim();
  if (!otherId) return;
  await ensureChat(otherId);
  otherIdInput.value = '';
});

sendBtn.addEventListener('click', async () => {
  await sendMessage();
});

messageInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    await sendMessage();
  }
});

reloadMessagesBtn.addEventListener('click', async () => {
  await loadMessagesForActiveChat();
});

// Hash-Invite (#USERID) verarbeiten & initiale Daten laden
(async function init() {
  await loadChats();

  const hash = window.location.hash;
  if (hash.startsWith('#')) {
    const otherId = hash.slice(1);
    if (otherId && otherId !== myUserId) {
      await ensureChat(otherId);
    }
  }

  await loadMessagesForActiveChat();
})();
