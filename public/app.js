// app.js
// - User-ID & Anzeigename
// - Invite-Link & QR-Code
// - Chats mit "+" anlegen
// - Kontakt-Namen pro Chat speichern
// - automatische Aktualisierung der Nachrichten (Polling)
// - Text + Bilder (als data:image/...)
// - 1-View: Klick -> Nachricht wird gelöscht

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

// ---------- Anzeigename & Chat-Aliase ----------

const DISPLAY_NAME_KEY = 'siso_display_name';
const CHAT_ALIASES_KEY = 'siso_chat_aliases';

function loadDisplayName() {
  return localStorage.getItem(DISPLAY_NAME_KEY) || '';
}

function saveDisplayName(name) {
  localStorage.setItem(DISPLAY_NAME_KEY, name);
}

function loadChatAliases() {
  try {
    return JSON.parse(localStorage.getItem(CHAT_ALIASES_KEY)) || {};
  } catch {
    return {};
  }
}

function saveChatAliases(aliases) {
  localStorage.setItem(CHAT_ALIASES_KEY, JSON.stringify(aliases));
}

let chatAliases = loadChatAliases();

// ---------- DOM-Elemente ----------

const myIdSpan = document.getElementById('my-id');
const myShortIdSpan = document.getElementById('my-short-id');
const inviteLinkInput = document.getElementById('invite-link');
const copyLinkBtn = document.getElementById('copy-link-btn');

const displayNameInput = document.getElementById('display-name-input');
const saveDisplayNameBtn = document.getElementById('save-display-name-btn');

const addChatPlusBtn = document.getElementById('add-chat-plus');

const chatListUl = document.getElementById('chat-list');
const chatInfoDiv = document.getElementById('chat-info');
const renameChatBtn = document.getElementById('rename-chat-btn');
const reloadMessagesBtn = document.getElementById('reload-messages-btn');
const messageListUl = document.getElementById('message-list');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');

const imageInput = document.getElementById('image-input');
const sendImageBtn = document.getElementById('send-image-btn');

const qrcodeCanvas = document.getElementById('qrcode');

// ---------- Zustand im Browser ----------

let chats = [];           // Liste aller Chats (vom Server)
let messagesByChat = {};  // chatId -> Array von Nachrichten
let activeChatId = null;

const MESSAGE_POLL_INTERVAL_MS = 4000; // alle 4 Sekunden nach neuen Nachrichten fragen

// ---------- Anzeige: eigene ID & Invite ----------

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

// eigenen Anzeigenamen in Input laden
displayNameInput.value = loadDisplayName();

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
  loadMessagesForActiveChat().catch((e) => console.error(e));
}

// Hilfsfunktion: aus Eingabe (ID oder Invite-Link) eine UserID ziehen
function extractUserIdFromInput(raw) {
  if (!raw) return null;
  raw = raw.trim();
  const idx = raw.lastIndexOf('#');
  if (idx !== -1) {
    return raw.slice(idx + 1);
  }
  return raw;
}

// ---------- Nachrichten laden (mit Auto-Update) ----------

async function loadMessagesForActiveChat() {
  const chat = getActiveChat();
  if (!chat) return;
  const serverMsgs = await apiGet(
    `/api/messages?chatId=${encodeURIComponent(chat.id)}&userId=${encodeURIComponent(myUserId)}`
  );

  const existing = messagesByChat[chat.id] || [];
  const localOnly = existing.filter((m) => m.localOnly);

  const combined = [...serverMsgs, ...localOnly];
  combined.sort((a, b) => a.createdAt - b.createdAt);

  messagesByChat[chat.id] = combined;
  renderMessages();
}

// ---------- Nachricht senden (Text & Bilder) ----------

async function sendMessage() {
  const chat = getActiveChat();
  if (!chat) {
    alert('Bitte zuerst einen Chat auswählen oder anlegen.');
    return;
  }
  const text = messageInput.value.trim();
  if (!text) return;

  await sendMessageContent(text);
  messageInput.value = '';
}

async function sendMessageContent(content) {
  const chat = getActiveChat();
  if (!chat) return;
  const otherId = chat.userAId === myUserId ? chat.userBId : chat.userAId;

  await apiPost('/api/messages', {
    chatId: chat.id,
    senderId: myUserId,
    receiverId: otherId,
    content,
  });

  if (!messagesByChat[chat.id]) {
    messagesByChat[chat.id] = [];
  }
  messagesByChat[chat.id].push({
    id: crypto.randomUUID(),
    chatId: chat.id,
    senderId: myUserId,
    receiverId: otherId,
    content,
    createdAt: Date.now(),
    localOnly: true,
  });
  renderMessages();
}

async function sendImage() {
  const chat = getActiveChat();
  if (!chat) {
    alert('Bitte zuerst einen Chat auswählen oder anlegen.');
    return;
  }
  const file = imageInput.files && imageInput.files[0];
  if (!file) {
    alert('Bitte zuerst ein Bild auswählen.');
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    alert('Bild ist zu groß (max. ca. 2MB).');
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result; // "data:image/png;base64,..."
    if (typeof dataUrl === 'string') {
      await sendMessageContent(dataUrl);
      imageInput.value = '';
    }
  };
  reader.readAsDataURL(file);
}

// ---------- Nachricht "lesen" (1-View) ----------

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

function getOtherUserId(chat) {
  return chat.userAId === myUserId ? chat.userBId : chat.userAId;
}

function getChatDisplayName(chat) {
  const alias = chatAliases[chat.id];
  if (alias && alias.trim()) return alias.trim();
  const otherId = getOtherUserId(chat);
  return `User ${getShortId(otherId)}…`;
}

function renderChatList() {
  chatListUl.innerHTML = '';
  chats.forEach((chat) => {
    const li = document.createElement('li');
    li.textContent = getChatDisplayName(chat);
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
  const displayName = getChatDisplayName(chat);
  chatInfoDiv.textContent = `Chat: ${displayName}`;
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

    const isImage =
      typeof msg.content === 'string' && msg.content.startsWith('data:image/');

    if (isImage) {
      const img = document.createElement('img');
      img.src = msg.content;
      img.classList.add('msg-image');
      li.appendChild(img);

      const caption = document.createElement('div');
      caption.textContent = '👁️ Bild – einmal tippen, danach gelöscht';
      li.appendChild(caption);
    } else {
      li.textContent = `👁️ ${msg.content}`;
    }

    li.addEventListener('click', () => onMessageClicked(msg));
    messageListUl.appendChild(li);
  });

  // Scroll automatisch nach unten
  messageListUl.scrollTop = messageListUl.scrollHeight;
}

// ---------- Events ----------

copyLinkBtn.addEventListener('click', () => {
  inviteLinkInput.select();
  document.execCommand('copy');
  alert('Invite-Link in die Zwischenablage kopiert.');
});

saveDisplayNameBtn.addEventListener('click', () => {
  const name = displayNameInput.value.trim();
  saveDisplayName(name);
  alert('Anzeigename gespeichert.');
});

addChatPlusBtn.addEventListener('click', async () => {
  const raw = prompt('ID oder Invite-Link der anderen Person eingeben:');
  const otherId = extractUserIdFromInput(raw || '');
  if (!otherId) return;
  await ensureChat(otherId);
});

renameChatBtn.addEventListener('click', () => {
  const chat = getActiveChat();
  if (!chat) return;
  const currentAlias = chatAliases[chat.id] || '';
  const newName = prompt('Name für diesen Kontakt:', currentAlias);
  if (newName === null) return; // Abbrechen
  chatAliases[chat.id] = newName.trim();
  saveChatAliases(chatAliases);
  renderChatList();
  renderChatInfo();
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

sendImageBtn.addEventListener('click', async () => {
  await sendImage();
});

// ---------- Initialisierung (inkl. Auto-Polling) ----------

(async function init() {
  await loadChats();

  // Hash-Invite (#USERID) verarbeiten
  const hash = window.location.hash;
  if (hash.startsWith('#')) {
    const otherId = hash.slice(1);
    if (otherId && otherId !== myUserId) {
      await ensureChat(otherId);
    }
  }

  await loadMessagesForActiveChat();

  // Auto-Polling: alle X Sekunden neue Nachrichten holen
  setInterval(() => {
    loadMessagesForActiveChat().catch((e) => console.error(e));
  }, MESSAGE_POLL_INTERVAL_MS);
})();
