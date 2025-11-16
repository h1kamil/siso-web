// app.js (robuste Version)
// - User-ID & feste ID (übertragbar auf andere Geräte)
// - Anzeigename (auf Server gespeichert)
// - Invite-Link & QR-Code
// - Chats mit "+" anlegen
// - automatisches Polling für Nachrichten
// - Text & Bilder (Album + Kamera)
// - 1-View: ✕ löscht Nachricht
// - Chat-Löschen (für beide)
// - Profil/ID-Bereich per + ein-/ausblendbar

// ---------- User-ID ----------

function createRandomId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  // Fallback, falls randomUUID nicht unterstützt
  return (
    "id-" +
    Math.random().toString(36).slice(2) +
    "-" +
    Date.now().toString(36)
  );
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

let userProfiles = {}; // userId -> {id,
