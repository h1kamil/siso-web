// app.js
// - User-ID & feste ID (übertragbar auf andere Geräte)
// - Anzeigename (auf Server gespeichert, Gegenüber sieht ihn)
// - Invite-Link & QR-Code
// - automatische Registrierung als User (für Dashboard-Count)
// - Chats mit "+" anlegen & löschen
// - Suche nach ID/Invite-Link ODER Anzeigename (case-insensitive, Teilstrings)
// - automatisches Polling für Nachrichten
// - Text & Bilder (Album + Kamera)
// - 1-View: ✕ löscht Nachricht
// - Profil/ID-Bereich per + ein-/ausblendbar
// - Admin-Dashboard (Stats) nur mit Admin-Code
// - Kompatibel ohne moderne Syntax (kein ??, Fallback für randomUUID)

// ---------- Helper: sichere Random-ID ----------

function safeRandomId() {
  try {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
  } catch (e) {
    console.warn('crypto.randomUUID nicht verfügbar, nutze Fallback');
  }
  // Simple Fallback
  return 'id-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

// ---------- User-ID ----------

function getOrCreateUserId() {
  var id = localStorage.getItem('siso_user_id');
  if (!id) {
    id = safeRandomId();
    localStorage.setItem('siso_user_id', id);
  }
  return id;
}

function getShortId(fullId) {
  return fullId.slice(0, 8);
}

var myUserId = getOrCreateUserId();
var myShortId = getShortId(myUserId);

// ---------- Anzeigename ----------

var DISPLAY_NAME_KEY = 'siso_display_name';

function loadDisplayNameLocal() {
  return localStorage.getItem(DISPLAY_NAME_KEY) || '';
}

function saveDisplayNameLocal(name) {
  localStorage.setItem(DISPLAY_NAME_KEY, name);
}

var userProfiles = {}; // userId -> {id, displayName}

// ---------- DOM ----------

var myIdSpan = document.getElementById('my-id');
var myShortIdSpan = document.getElementById('my-short-id');
var inviteLinkInput = document.getElementById('invite-link');
var copyLinkBtn = document.getElementById('copy-link-btn');
var fixedIdInput = document.getElementById('fixed-id-input');
var setFixedIdBtn = document.getElementById('set-fixed-id-btn');

var adminCodeInput = document.getElementById('admin-code-input');
var loadDashboardBtn = document.getElementById('load-dashboard-btn');
var dashUserCountSpan = document.getElementById('dash-user-count');
var dashChatCountSpan = document.getElementById('dash-chat-count');
var dashMessageCountSpan = document.getElementById('dash-message-count');
var dashMsg24hSpan = document.getElementById('dash-msg-24h');
var dashMsg7dSpan = document.getElementById('dash-msg-7d');
var dashMyMessagesSpan = document.getElementById('dash-my-messages');

var displayNameInput = document.getElementById('display-name-input');
var saveDisplayNameBtn = document.getElementById('save-display-name-btn');

var toggleMetaBtn = document.getElementById('toggle-meta-btn');
var metaPanel = document.getElementById('meta-panel');

var addChatPlusBtn = document.getElementById('add-chat-plus');

var chatListUl = document.getElementById('chat-list');
var chatInfoDiv = document.getElementById('chat-info');
var deleteChatBtn = document.getElementById('delete-chat-btn');
var reloadMessagesBtn = document.getElementById('reload-messages-btn');
var messageListUl = document.getElementById('message-list');
var messageInput = document.getElementById('message-input');
var sendBtn = document.getElementById('send-btn');

var imageInput = document.getElementById('image-input');
var sendImageBtn = document.getElementById('send-image-btn');
var cameraBtn = document.getElementById('camera-btn');

var cameraModal = document.getElementById('camera-modal');
var cameraVideo = document.getElementById('camera-video');
var takePhotoBtn = document.getElementById('take-photo-btn');
var closeCameraBtn = document.getElementById('close-camera-btn');

var qrcodeCanvas = document.getElementById('qrcode');

// ---------- Zustand ----------

var chats = [];
var messagesByChat = {};
var activeChatId = null;
var cameraStream = null;

var MESSAGE_POLL_INTERVAL_MS = 4000;

// ---------- Basisanzeige ----------

if (myIdSpan) myIdSpan.textContent = myUserId;
if (myShortIdSpan) myShortIdSpan.textContent = myShortId;

var inviteLink = window.location.origin + '/#' + myUserId;
if (inviteLinkInput) inviteLinkInput.value = inviteLink;

// feste ID-Feld vorbefüllen
if (fixedIdInput) {
  fixedIdInput.value = myUserId;
}

// QR-Code
if (window.QRCode && qrcodeCanvas) {
  window.QRCode.toCanvas(qrcodeCanvas, inviteLink, { width: 200 }, function (error) {
    if (error) console.error(error);
  });
}

if (displayNameInput) {
  displayNameInput.value = loadDisplayNameLocal();
}

// ---------- API Helper ----------

function apiGet(path) {
  return fetch(path).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (text) {
        throw new Error('GET ' + path + ' fehlgeschlagen: ' + res.status + ' ' + text);
      });
    }
    return res.json();
  });
}

function apiPost(path, bodyObj) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (text) {
        throw new Error('POST ' + path + ' fehlgeschlagen: ' + res.status + ' ' + text);
      });
    }
    return res.json();
  });
}

function apiDelete(path) {
  return fetch(path, { method: 'DELETE' }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (text) {
        throw new Error('DELETE ' + path + ' fehlgeschlagen: ' + res.status + ' ' + text);
      });
    }
    return res.json();
  });
}

// ---------- User-Profile ----------

function refreshUserProfiles() {
  if (!chats.length) return Promise.resolve();

  var idsSetObj = {};
  chats.forEach(function (c) {
    idsSetObj[c.userAId] = true;
    idsSetObj[c.userBId] = true;
  });
  idsSetObj[myUserId] = true;

  var ids = Object.keys(idsSetObj);
  var query = encodeURIComponent(ids.join(','));

  return apiGet('/api/users?ids=' + query)
    .then(function (rows) {
      userProfiles = {};
      rows.forEach(function (u) {
        userProfiles[u.id] = u;
      });
      renderChatList();
      renderChatInfo();
    })
    .catch(function (e) {
      console.error('Fehler beim Laden der User-Profile', e);
    });
}

function getUserDisplayName(userId) {
  var profile = userProfiles[userId];
  if (profile && profile.displayName) return profile.displayName;
  return null;
}

// beim Start sicherstellen, dass es einen Eintrag in "users" gibt
function ensureUserProfile() {
  var name = displayNameInput && displayNameInput.value
    ? displayNameInput.value.trim()
    : '';
  if (!name) {
    name = 'User ' + myShortId;
  }
  return apiPost('/api/users/profile', {
    userId: myUserId,
    displayName: name,
  }).catch(function (e) {
    console.error('Fehler beim Initial-Userprofil:', e);
  });
}

// ---------- Chats ----------

function loadChats() {
  return apiGet('/api/chats?userId=' + encodeURIComponent(myUserId))
    .then(function (data) {
      chats = data;
      renderChatList();
      if (!activeChatId && chats.length > 0) {
        activeChatId = chats[0].id;
      }
      renderChatInfo();
      return refreshUserProfiles();
    })
    .catch(function (e) {
      console.error('Fehler beim Laden der Chats', e);
    });
}

function ensureChat(otherUserId) {
  return apiPost('/api/chats', {
    myUserId: myUserId,
    otherUserId: otherUserId,
  })
    .then(function (res) {
      var chatId = res.chatId;
      return loadChats().then(function () {
        setActiveChat(chatId);
      });
    })
    .catch(function (e) {
      console.error('Fehler beim Anlegen des Chats', e);
      alert('Chat konnte nicht angelegt werden.');
    });
}

function getActiveChat() {
  if (!activeChatId) return null;
  for (var i = 0; i < chats.length; i++) {
    if (chats[i].id === activeChatId) return chats[i];
  }
  return null;
}

function setActiveChat(chatId) {
  activeChatId = chatId;
  renderChatList();
  renderChatInfo();
  loadMessagesForActiveChat();
}

function extractUserIdFromInput(raw) {
  if (!raw) return null;
  raw = raw.trim();
  var idx = raw.lastIndexOf('#');
  if (idx !== -1) {
    return raw.slice(idx + 1);
  }
  return null; // reine Strings ohne # behandeln wir als Namen
}

// Namenssuche (Frontend)
function searchUsersByName(query) {
  return apiGet('/api/users/find?q=' + encodeURIComponent(query));
}

// ---------- Nachrichten ----------

function loadMessagesForActiveChat() {
  var chat = getActiveChat();
  if (!chat) return;
  apiGet(
    '/api/messages?chatId=' +
      encodeURIComponent(chat.id) +
      '&userId=' +
      encodeURIComponent(myUserId)
  )
    .then(function (msgsFromServer) {
      var existing = messagesByChat[chat.id] || [];
      var localOnly = existing.filter(function (m) {
        return m.localOnly;
      });

      var combined = msgsFromServer.concat(localOnly);
      combined.sort(function (a, b) {
        return a.createdAt - b.createdAt;
      });

      messagesByChat[chat.id] = combined;
      renderMessages();
    })
    .catch(function (e) {
      console.error('Fehler beim Laden der Nachrichten', e);
    });
}

function sendMessage() {
  var chat = getActiveChat();
  if (!chat) {
    alert('Bitte zuerst einen Chat auswählen oder anlegen.');
    return;
  }
  var text = messageInput && messageInput.value
    ? messageInput.value.trim()
    : '';
  if (!text) return;

  sendMessageContent(text).then(function () {
    if (messageInput) messageInput.value = '';
  });
}

function sendMessageContent(content) {
  var chat = getActiveChat();
  if (!chat) return Promise.resolve();
  var otherId = chat.userAId === myUserId ? chat.userBId : chat.userAId;

  return apiPost('/api/messages', {
    chatId: chat.id,
    senderId: myUserId,
    receiverId: otherId,
    content: content,
  })
    .then(function () {
      if (!messagesByChat[chat.id]) {
        messagesByChat[chat.id] = [];
      }
      messagesByChat[chat.id].push({
        id: safeRandomId(),
        chatId: chat.id,
        senderId: myUserId,
        receiverId: otherId,
        content: content,
        createdAt: Date.now(),
        localOnly: true,
      });
      renderMessages();
    })
    .catch(function (e) {
      console.error('Fehler beim Senden der Nachricht', e);
      alert('Nachricht konnte nicht gesendet werden.');
    });
}

// Bild aus Album
function sendImageFromInput() {
  var chat = getActiveChat();
  if (!chat) {
    alert('Bitte zuerst einen Chat auswählen oder anlegen.');
    return;
  }
  if (!imageInput || !imageInput.files || !imageInput.files[0]) {
    alert('Bitte zuerst ein Bild auswählen.');
    return;
  }
  var file = imageInput.files[0];

  if (file.size > 2 * 1024 * 1024) {
    alert('Bild ist zu groß (max. ca. 2MB).');
    return;
  }

  var reader = new FileReader();
  reader.onload = function () {
    var dataUrl = reader.result;
    if (typeof dataUrl === 'string') {
      sendMessageContent(dataUrl).then(function () {
        imageInput.value = '';
      });
    }
  };
  reader.readAsDataURL(file);
}

// Kamera

function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Dein Browser unterstützt die Kamera-Funktion hier leider nicht.');
    return;
  }
  navigator.mediaDevices
    .getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    })
    .then(function (stream) {
      cameraStream = stream;
      if (cameraVideo) cameraVideo.srcObject = stream;
      if (cameraModal) cameraModal.classList.remove('hidden');
    })
    .catch(function (e) {
      console.error(e);
      alert('Kamera konnte nicht geöffnet werden (Berechtigungen prüfen).');
    });
}

function closeCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(function (t) {
      t.stop();
    });
    cameraStream = null;
  }
  if (cameraVideo) cameraVideo.srcObject = null;
  if (cameraModal) cameraModal.classList.add('hidden');
}

function takePhoto() {
  if (!cameraStream) return;
  var chat = getActiveChat();
  if (!chat) {
    alert('Bitte zuerst einen Chat auswählen oder anlegen.');
    return;
  }

  var video = cameraVideo;
  if (!video || !video.videoWidth || !video.videoHeight) {
    alert('Kamera ist noch nicht bereit. Bitte kurz warten und erneut versuchen.');
    return;
  }

  var canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  var dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  sendMessageContent(dataUrl).then(function () {
    closeCamera();
  });
}

// Nachricht löschen (1-View)
function onMessageClicked(msg) {
  var chat = getActiveChat();
  if (!chat) return;

  var promise;
  if (!msg.localOnly) {
    promise = apiPost('/api/messages/' + encodeURIComponent(msg.id) + '/view', {});
  } else {
    promise = Promise.resolve();
  }

  promise
    .catch(function (e) {
      console.error('Fehler beim Löschen der Nachricht:', e);
    })
    .then(function () {
      var arr = messagesByChat[chat.id] || [];
      messagesByChat[chat.id] = arr.filter(function (m) {
        return m.id !== msg.id;
      });
      renderMessages();
    });
}

// Chat löschen
function deleteActiveChat() {
  var chat = getActiveChat();
  if (!chat) {
    alert('Kein Chat ausgewählt.');
    return;
  }

  var confirmed = window.confirm(
    'Diesen Chat und alle Nachrichten FÜR EUCH BEIDE endgültig löschen?'
  );
  if (!confirmed) return;

  apiDelete(
    '/api/chats/' + encodeURIComponent(chat.id) + '?userId=' + encodeURIComponent(myUserId)
  )
    .then(function () {
      chats = chats.filter(function (c) {
        return c.id !== chat.id;
      });
      delete messagesByChat[chat.id];

      if (chats.length > 0) {
        activeChatId = chats[0].id;
      } else {
        activeChatId = null;
      }

      renderChatList();
      renderChatInfo();
      renderMessages();
    })
    .catch(function (e) {
      console.error(e);
      alert('Fehler beim Löschen des Chats.');
    });
}

// ---------- Admin-Dashboard ----------

function loadDashboard() {
  if (!adminCodeInput) return;
  var code = adminCodeInput.value ? adminCodeInput.value.trim() : '';
  if (!code) {
    alert('Bitte Admin-Code eingeben.');
    return;
  }

  apiPost('/api/admin/stats', {
    adminCode: code,
    userId: myUserId,
  })
    .then(function (data) {
      if (dashUserCountSpan)
        dashUserCountSpan.textContent =
          data.userCount !== undefined && data.userCount !== null ? data.userCount : '0';
      if (dashChatCountSpan)
        dashChatCountSpan.textContent =
          data.chatCount !== undefined && data.chatCount !== null ? data.chatCount : '0';
      if (dashMessageCountSpan)
        dashMessageCountSpan.textContent =
          data.messageCount !== undefined && data.messageCount !== null
            ? data.messageCount
            : '0';
      if (dashMsg24hSpan)
        dashMsg24hSpan.textContent =
          data.messagesLast24h !== undefined && data.messagesLast24h !== null
            ? data.messagesLast24h
            : '0';
      if (dashMsg7dSpan)
        dashMsg7dSpan.textContent =
          data.messagesLast7d !== undefined && data.messagesLast7d !== null
            ? data.messagesLast7d
            : '0';
      if (dashMyMessagesSpan)
        dashMyMessagesSpan.textContent =
          data.mySentMessages !== undefined && data.mySentMessages !== null
            ? data.mySentMessages
            : '0';
    })
    .catch(function (e) {
      console.error('Fehler beim Laden des Dashboards', e);
      alert('Dashboard konnte nicht geladen werden (Admin-Code korrekt?).');
      if (dashUserCountSpan) dashUserCountSpan.textContent = '–';
      if (dashChatCountSpan) dashChatCountSpan.textContent = '–';
      if (dashMessageCountSpan) dashMessageCountSpan.textContent = '–';
      if (dashMsg24hSpan) dashMsg24hSpan.textContent = '–';
      if (dashMsg7dSpan) dashMsg7dSpan.textContent = '–';
      if (dashMyMessagesSpan) dashMyMessagesSpan.textContent = '–';
    });
}

// ---------- Rendering ----------

function getOtherUserId(chat) {
  return chat.userAId === myUserId ? chat.userBId : chat.userAId;
}

function getChatDisplayName(chat) {
  var otherId = getOtherUserId(chat);
  var name = getUserDisplayName(otherId);
  if (name) return name;
  return 'User ' + getShortId(otherId) + '…';
}

function renderChatList() {
  if (!chatListUl) return;
  chatListUl.innerHTML = '';
  chats.forEach(function (chat) {
    var li = document.createElement('li');
    li.textContent = getChatDisplayName(chat);
    if (chat.id === activeChatId) {
      li.classList.add('active');
    }
    li.addEventListener('click', function () {
      setActiveChat(chat.id);
    });
    chatListUl.appendChild(li);
  });
}

function renderChatInfo() {
  if (!chatInfoDiv) return;
  var chat = getActiveChat();
  if (!chat) {
    chatInfoDiv.textContent = 'Kein Chat ausgewählt.';
    return;
  }
  var name = getChatDisplayName(chat);
  chatInfoDiv.textContent = 'Chat mit ' + name;
}

function renderMessages() {
  if (!messageListUl) return;
  var chat = getActiveChat();
  messageListUl.innerHTML = '';
  if (!chat) return;
  var arr = messagesByChat[chat.id] || [];

  arr.forEach(function (msg) {
    var li = document.createElement('li');
    var isMe = msg.senderId === myUserId;
    li.classList.add(isMe ? 'msg-me' : 'msg-other');

    var contentDiv = document.createElement('div');
    contentDiv.classList.add('msg-content', 'msg-text');

    var isImage =
      typeof msg.content === 'string' && msg.content.indexOf('data:image/') === 0;

    if (isImage) {
      var img = document.createElement('img');
      img.src = msg.content;
      img.classList.add('msg-image');
      contentDiv.appendChild(img);

      var caption = document.createElement('div');
      caption.textContent = '👁️ Bild – über ✕ löschen';
      contentDiv.appendChild(caption);
    } else {
      contentDiv.textContent = '👁️ ' + msg.content;
    }

    var closeBtn = document.createElement('button');
    closeBtn.classList.add('msg-close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', function (e) {
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
  copyLinkBtn.addEventListener('click', function () {
    inviteLinkInput.select();
    document.execCommand('copy');
    alert('Invite-Link in die Zwischenablage kopiert.');
  });
}

if (saveDisplayNameBtn && displayNameInput) {
  saveDisplayNameBtn.addEventListener('click', function () {
    var name = displayNameInput.value.trim();
    if (!name) {
      alert('Bitte einen Namen eingeben.');
      return;
    }
    saveDisplayNameLocal(name);
    apiPost('/api/users/profile', {
      userId: myUserId,
      displayName: name,
    })
      .then(function () {
        alert('Anzeigename gespeichert.');
        return refreshUserProfiles();
      })
      .catch(function (e) {
        console.error(e);
        alert('Fehler beim Speichern des Namens.');
      });
  });
}

if (setFixedIdBtn && fixedIdInput) {
  setFixedIdBtn.addEventListener('click', function () {
    var newId = fixedIdInput.value ? fixedIdInput.value.trim() : '';
    if (!newId) {
      alert('Bitte eine ID eingeben.');
      return;
    }
    if (newId.length < 6 || newId.length > 64) {
      alert('Die ID sollte zwischen 6 und 64 Zeichen lang sein.');
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(newId)) {
      alert('Bitte nur Buchstaben, Zahlen, Punkt, Unterstrich oder Bindestrich verwenden.');
      return;
    }

    var confirmed = window.confirm(
      'Wenn du deine ID änd
