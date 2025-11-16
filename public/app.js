// app.js
// - User-ID & feste ID
// - Anzeigename (Server)
// - Invite-Link
// - Chats mit "+"
// - Nachrichten & Bilder (Album + Kamera)
// - 1-View: ✕ löscht Nachricht
// - Chat löschen (für beide)
// - Profil-Bereich ein-/ausblendbar

// ---------- User-ID ----------

function createRandomId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return "id-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
}

function getOrCreateUserId() {
  let id = localStorage.getItem("siso_user_id");
  if (!id) {
    id = createRandomId();
    localStorage.setItem("siso_user_id", id);
  }
  return id;
}

function getShortId(fullId) {
  return fullId.slice(0, 8);
}

const myUserId = getOrCreateUserId();
const myShortId = getShortId(myUserId);

// ---------- Anzeigename ----------

const DISPLAY_NAME_KEY = "siso_display_name";

function loadDisplayNameLocal() {
  return localStorage.getItem(DISPLAY_NAME_KEY) || "";
}

function saveDisplayNameLocal(name) {
  localStorage.setItem(DISPLAY_NAME_KEY, name);
}

let userProfiles = {}; // userId -> {id, displayName}

// ---------- DOM ----------

const myIdSpan = document.getElementById("my-id");
const myShortIdSpan = document.getElementById("my-short-id");
const inviteLinkInput = document.getElementById("invite-link");
const copyLinkBtn = document.getElementById("copy-link-btn");
const fixedIdInput = document.getElementById("fixed-id-input");
const setFixedIdBtn = document.getElementById("set-fixed-id-btn");

const displayNameInput = document.getElementById("display-name-input");
const saveDisplayNameBtn = document.getElementById("save-display-name-btn");

const toggleMetaBtn = document.getElementById("toggle-meta-btn");
const metaPanel = document.getElementById("meta-panel");

const addChatPlusBtn = document.getElementById("add-chat-plus");

const chatListUl = document.getElementById("chat-list");
const chatInfoDiv = document.getElementById("chat-info");
const deleteChatBtn = document.getElementById("delete-chat-btn");
const reloadMessagesBtn = document.getElementById("reload-messages-btn");
const messageListUl = document.getElementById("message-list");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");

const imageInput = document.getElementById("image-input");
const sendImageBtn = document.getElementById("send-image-btn");
const cameraBtn = document.getElementById("camera-btn");

const cameraModal = document.getElementById("camera-modal");
const cameraVideo = document.getElementById("camera-video");
const takePhotoBtn = document.getElementById("take-photo-btn");
const closeCameraBtn = document.getElementById("close-camera-btn");

// ---------- Zustand ----------

let chats = [];
let messagesByChat = {};
let activeChatId = null;
let cameraStream = null;

const MESSAGE_POLL_INTERVAL_MS = 4000;

// ---------- Basisanzeige ----------

if (myIdSpan) myIdSpan.textContent = myUserId;
if (myShortIdSpan) myShortIdSpan.textContent = myShortId;

const inviteLink = `${window.location.origin}/#${myUserId}`;
if (inviteLinkInput) inviteLinkInput.value = inviteLink;

if (fixedIdInput) {
  fixedIdInput.value = myUserId;
}

if (displayNameInput) {
  displayNameInput.value = loadDisplayNameLocal();
}

// ---------- API Helper ----------

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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} fehlgeschlagen: ${res.status} ${text}`);
  }
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DELETE ${path} fehlgeschlagen: ${res.status} ${text}`);
  }
  return res.json();
}

// ---------- User-Profile ----------

async function refreshUserProfiles() {
  if (!chats.length) return;

  const idsSet = new Set();
  chats.forEach((c) => {
    idsSet.add(c.userAId);
    idsSet.add(c.userBId);
  });
  idsSet.add(myUserId);

  const ids = Array.from(idsSet);
  const query = encodeURIComponent(ids.join(","));

  const rows = await apiGet(`/api/users?ids=${query}`);
  userProfiles = {};
  rows.forEach((u) => {
    userProfiles[u.id] = u;
  });

  renderChatList();
  renderChatInfo();
}

function getUserDisplayName(userId) {
  const profile = userProfiles[userId];
  if (profile && profile.displayName) return profile.displayName;
  return null;
}

// ---------- Chats ----------

async function loadChats() {
  const data = await apiGet(`/api/chats?userId=${encodeURIComponent(myUserId)}`);
  chats = data;
  renderChatList();
  if (!activeChatId && chats.length > 0) {
    activeChatId = chats[0].id;
  }
  renderChatInfo();
  await refreshUserProfiles();
}

async function ensureChat(otherUserId) {
  const res = await apiPost("/api/chats", {
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

function extractUserIdFromInput(raw) {
  if (!raw) return null;
  raw = raw.trim();
  const idx = raw.lastIndexOf("#");
  if (idx !== -1) {
    return raw.slice(idx + 1);
  }
  return raw;
}

// ---------- Nachrichten ----------

async function loadMessagesForActiveChat() {
  const chat = getActiveChat();
  if (!chat || !messageListUl) return;
  const msgsFromServer = await apiGet(
    `/api/messages?chatId=${encodeURIComponent(
      chat.id
    )}&userId=${encodeURIComponent(myUserId)}`
  );

  const existing = messagesByChat[chat.id] || [];
  const localOnly = existing.filter((m) => m.localOnly);

  const combined = [...msgsFromServer, ...localOnly];
  combined.sort((a, b) => a.createdAt - b.createdAt);

  messagesByChat[chat.id] = combined;
  renderMessages();
}

async function sendMessage() {
  const chat = getActiveChat();
  if (!chat) {
    alert("Bitte zuerst einen Chat auswählen oder anlegen.");
    return;
  }
  if (!messageInput) return;
  const text = messageInput.value.trim();
  if (!text) return;

  await sendMessageContent(text);
  messageInput.value = "";
}

async function sendMessageContent(content) {
  const chat = getActiveChat();
  if (!chat) return;
  const otherId = chat.userAId === myUserId ? chat.userBId : chat.userAId;

  await apiPost("/api/messages", {
    chatId: chat.id,
    senderId: myUserId,
    receiverId: otherId,
    content,
  });

  if (!messagesByChat[chat.id]) {
    messagesByChat[chat.id] = [];
  }
  messagesByChat[chat.id].push({
    id: createRandomId(),
    chatId: chat.id,
    senderId: myUserId,
    receiverId: otherId,
    content,
    createdAt: Date.now(),
    localOnly: true,
  });
  renderMessages();
}

// Bild aus Album

async function sendImageFromInput() {
  const chat = getActiveChat();
  if (!chat) {
    alert("Bitte zuerst einen Chat auswählen oder anlegen.");
    return;
  }
  if (!imageInput) return;
  const file = imageInput.files && imageInput.files[0];
  if (!file) {
    alert("Bitte zuerst ein Bild auswählen.");
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    alert("Bild ist zu groß (max. ca. 2MB).");
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    if (typeof dataUrl === "string") {
      await sendMessageContent(dataUrl);
      imageInput.value = "";
    }
  };
  reader.readAsDataURL(file);
}

// Kamera

async function openCamera() {
  if (!cameraModal || !cameraVideo) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("Dein Browser unterstützt die Kamera-Funktion hier leider nicht.");
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  } catch (e) {
    console.error(e);
    alert("Kamera konnte nicht geöffnet werden (Berechtigungen prüfen).");
    return;
  }

  cameraVideo.srcObject = cameraStream;
  cameraModal.classList.remove("hidden");
}

function closeCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  if (cameraVideo) cameraVideo.srcObject = null;
  if (cameraModal) cameraModal.classList.add("hidden");
}

async function takePhoto() {
  if (!cameraStream) return;
  const chat = getActiveChat();
  if (!chat) {
    alert("Bitte zuerst einen Chat auswählen oder anlegen.");
    return;
  }
  if (!cameraVideo) return;

  const video = cameraVideo;
  if (!video.videoWidth || !video.videoHeight) {
    alert("Kamera ist noch nicht bereit. Bitte kurz warten und erneut versuchen.");
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  await sendMessageContent(dataUrl);
  closeCamera();
}

// Nachricht löschen (1-View)

async function onMessageClicked(msg) {
  const chat = getActiveChat();
  if (!chat) return;

  if (!msg.localOnly) {
    try {
      await apiPost(`/api/messages/${encodeURIComponent(msg.id)}/view`, {});
    } catch (e) {
      console.error("Fehler beim Löschen der Nachricht:", e);
    }
  }

  const arr = messagesByChat[chat.id] || [];
  messagesByChat[chat.id] = arr.filter((m) => m.id !== msg.id);
  renderMessages();
}

// Chat löschen

async function deleteActiveChat() {
  const chat = getActiveChat();
  if (!chat) {
    alert("Kein Chat ausgewählt.");
    return;
  }

  const confirmed = confirm(
    "Diesen Chat und alle Nachrichten FÜR EUCH BEIDE endgültig löschen?"
  );
  if (!confirmed) return;

  try {
    await apiDelete(
      `/api/chats/${encodeURIComponent(chat.id)}?userId=${encodeURIComponent(
        myUserId
      )}`
    );
  } catch (e) {
    console.error(e);
    alert("Fehler beim Löschen des Chats.");
    return;
  }

  chats = chats.filter((c) => c.id !== chat.id);
  delete messagesByChat[chat.id];

  if (chats.length > 0) {
    activeChatId = chats[0].id;
  } else {
    activeChatId = null;
  }

  renderChatList();
  renderChatInfo();
  renderMessages();
}

// ---------- Rendering ----------

function getOtherUserId(chat) {
  return chat.userAId === myUserId ? chat.userBId : chat.userAId;
}

function getChatDisplayName(chat) {
  const otherId = getOtherUserId(chat);
  const name = getUserDisplayName(otherId);
  if (name) return name;
  return `User ${getShortId(otherId)}…`;
}

function renderChatList() {
  if (!chatListUl) return;
  chatListUl.innerHTML = "";
  chats.forEach((chat) => {
    const li = document.createElement("li");
    li.textContent = getChatDisplayName(chat);
    if (chat.id === activeChatId) {
      li.classList.add("active");
    }
    li.addEventListener("click", () => setActiveChat(chat.id));
    chatListUl.appendChild(li);
  });
}

function renderChatInfo() {
  if (!chatInfoDiv) return;
  const chat = getActiveChat();
  if (!chat) {
    chatInfoDiv.textContent = "Kein Chat ausgewählt.";
    return;
  }
  const name = getChatDisplayName(chat);
  chatInfoDiv.textContent = `Chat mit ${name}`;
}

function renderMessages() {
  if (!messageListUl) return;
  const chat = getActiveChat();
  messageListUl.innerHTML = "";
  if (!chat) return;
  const arr = messagesByChat[chat.id] || [];

  arr.forEach((msg) => {
    const li = document.createElement("li");
    const isMe = msg.senderId === myUserId;
    li.classList.add(isMe ? "msg-me" : "msg-other");

    const contentDiv = document.createElement("div");
    contentDiv.classList.add("msg-content", "msg-text");

    const isImage =
      typeof msg.content === "string" &&
      msg.content.startsWith("data:image/");

    if (isImage) {
      const img = document.createElement("img");
      img.src = msg.content;
      img.classList.add("msg-image");
      contentDiv.appendChild(img);

      const caption = document.createElement("div");
      caption.textContent = "👁️ Bild – über ✕ löschen";
      contentDiv.appendChild(caption);
    } else {
      contentDiv.textContent = `👁️ ${msg.content}`;
    }

    const closeBtn = document.createElement("button");
    closeBtn.classList.add("msg-close");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onMessageClicked(msg);
    });

    li.appendChild(contentDiv);
    li.appendChild(closeBtn);
    messageListUl.appendChild(li);
  });

  messageListUl.scrollTop = messageListUl.scrollHeight;
}

// ---------- Events ----------

if (copyLinkBtn && inviteLinkInput) {
  copyLinkBtn.addEventListener("click", () => {
    inviteLinkInput.select();
    document.execCommand("copy");
    alert("Invite-Link in die Zwischenablage kopiert.");
  });
}

if (saveDisplayNameBtn && displayNameInput) {
  saveDisplayNameBtn.addEventListener("click", async () => {
    const name = displayNameInput.value.trim();
    if (!name) {
      alert("Bitte einen Namen eingeben.");
      return;
    }
    saveDisplayNameLocal(name);
    try {
      await apiPost("/api/users/profile", {
        userId: myUserId,
        displayName: name,
      });
      alert("Anzeigename gespeichert.");
      await refreshUserProfiles();
    } catch (e) {
      console.error(e);
      alert("Fehler beim Speichern des Namens.");
    }
  });
}

if (setFixedIdBtn && fixedIdInput) {
  setFixedIdBtn.addEventListener("click", () => {
    const newId = (fixedIdInput.value || "").trim();
    if (!newId) {
      alert("Bitte eine ID eingeben.");
      return;
    }
    if (newId.length < 6 || newId.length > 64) {
      alert("Die ID sollte zwischen 6 und 64 Zeichen lang sein.");
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(newId)) {
      alert("Bitte nur Buchstaben, Zahlen, Punkt, Unterstrich oder Bindestrich verwenden.");
      return;
    }

    const confirmed = confirm(
      "Wenn du deine ID änderst, gehören bestehende Chats zu deiner alten ID. " +
        "Nur mit dieser neuen ID wirst du künftig als derselbe User erkannt. Fortfahren?"
    );
    if (!confirmed) return;

    localStorage.setItem("siso_user_id", newId);
    window.location.reload();
  });
}

if (toggleMetaBtn && metaPanel) {
  toggleMetaBtn.addEventListener("click", () => {
    metaPanel.classList.toggle("hidden");
  });
}

if (addChatPlusBtn) {
  addChatPlusBtn.addEventListener("click", async () => {
    const raw = prompt("ID oder Invite-Link der anderen Person eingeben:");
    const otherId = extractUserIdFromInput(raw || "");
    if (!otherId) return;
    await ensureChat(otherId);
  });
}

if (sendBtn) {
  sendBtn.addEventListener("click", async () => {
    await sendMessage();
  });
}

if (messageInput) {
  messageInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      await sendMessage();
    }
  });
}

if (reloadMessagesBtn) {
  reloadMessagesBtn.addEventListener("click", async () => {
    await loadMessagesForActiveChat();
  });
}

if (sendImageBtn) {
  sendImageBtn.addEventListener("click", async () => {
    await sendImageFromInput();
  });
}

if (cameraBtn) {
  cameraBtn.addEventListener("click", async () => {
    await openCamera();
  });
}

if (takePhotoBtn) {
  takePhotoBtn.addEventListener("click", async () => {
    await takePhoto();
  });
}

if (closeCameraBtn) {
  closeCameraBtn.addEventListener("click", () => {
    closeCamera();
  });
}

if (deleteChatBtn) {
  deleteChatBtn.addEventListener("click", async () => {
    await deleteActiveChat();
  });
}

// ---------- Init ----------

(async function init() {
  try {
    await loadChats();

    const hash = window.location.hash;
    if (hash.startsWith("#")) {
      const otherId = hash.slice(1);
      if (otherId && otherId !== myUserId) {
        await ensureChat(otherId);
      }
    }

    await loadMessagesForActiveChat();

    setInterval(() => {
      loadMessagesForActiveChat().catch((e) => console.error(e));
    }, MESSAGE_POLL_INTERVAL_MS);
  } catch (e) {
    console.error("Init-Fehler:", e);
  }
})();
