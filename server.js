// server.js
// Backend für siso auf Render
// - liefert die Web-App aus (index.html, app.js, style.css)
// - speichert Chats & Nachrichten in SQLite
// - verschlüsselt Nachrichten
// - löscht Nachrichten nach dem ersten "View"
// - speichert User-Anzeigenamen, damit andere sie sehen können

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Body als JSON einlesen
app.use(express.json());

// "public"-Ordner für statische Dateien (Frontend)
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Da
