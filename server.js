// server.js
// Backend für siso auf Render
// - liefert die Web-App aus (index.html, app.js, style.css)
// - speichert Chats & Nachrichten in SQLite
// - verschlüsselt Nachrichten
// - löscht Nachrichten nach dem ersten "View"

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

// ---------- Datenbank (SQLite) ----------
// SQLite = Datenbank in einer Datei (hier: siso.db)
const db = new sqlite3.Database(path.join(__dirname, 'siso.db'));

db.serialize(() => {
  // Tabelle für Chats (wer mit wem)
  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      userAId TEXT NOT NULL,
      userBId TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);

  // Tabelle für Nachrichten
  // ciphertext = verschlüsselter Text
  // iv + authTag = für Entschlüsselung
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chatId TEXT NOT NULL,
      senderId TEXT NOT NULL,
      receiverId TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      authTag TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
});

// ---------- Verschlüsselung ----------
//
// AES-256-GCM = moderner Standard für symmetrische Verschlüsselung.
// SECRET_KEY: geheimer Schlüssel (hier aus einer Passphrase abgeleitet).

const SECRET_KEY = crypto
  .createHash('sha256')
  .update('siso-super-secret-key') // in echt in ENV packen
  .digest(); // 32 Byte

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12); // Initialisierungs-Vektor
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decrypt(ciphertext, ivBase64, authTagBase64) {
  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ---------- Hilfsfunktion: Chat finden/erzeugen ----------
//
// Ein Chat existiert genau zwischen 2 UserIDs.
// Entweder wir finden ihn, oder wir legen ihn neu an.

function ensureChat(myUserId, otherUserId, callback) {
  db.get(
    `
    SELECT * FROM chats
    WHERE (userAId = ? AND userBId = ?)
       OR (userAId = ? AND userBId = ?)
  `,
    [myUserId, otherUserId, otherUserId, myUserId],
    (err, row) => {
      if (err) return callback(err);
      if (row) return callback(null, row.id); // existiert schon

      const chatId = crypto.randomUUID();
      const createdAt = Date.now();
      db.run(
        `
        INSERT INTO chats (id, userAId, userBId, createdAt)
        VALUES (?, ?, ?, ?)
      `,
        [chatId, myUserId, otherUserId, createdAt],
        (err2) => {
          if (err2) return callback(err2);
          callback(null, chatId);
        }
      );
    }
  );
}

// ---------- API: Chats ----------

// POST /api/chats  -> Chat zwischen zwei Usern erzeugen/finden
app.post('/api/chats', (req, res) => {
  const { myUserId, otherUserId } = req.body;
  if (!myUserId || !otherUserId) {
    return res.status(400).json({ error: 'myUserId und otherUserId sind erforderlich' });
  }
  if (myUserId === otherUserId) {
    return res.status(400).json({ error: 'Mit dir selbst chatten ergibt keinen Sinn 😉' });
  }

  ensureChat(myUserId, otherUserId, (err, chatId) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Fehler beim Anlegen des Chats' });
    }
    res.json({ chatId });
  });
});

// GET /api/chats?userId=...  -> alle Chats eines Users
app.get('/api/chats', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId erforderlich' });

  db.all(
    `
    SELECT * FROM chats
    WHERE userAId = ? OR userBId = ?
    ORDER BY createdAt DESC
  `,
    [userId, userId],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Fehler beim Laden der Chats' });
      }
      res.json(rows);
    }
  );
});

// ---------- API: Nachrichten ----------

// POST /api/messages  -> Nachricht speichern (verschlüsselt)
app.post('/api/messages', (req, res) => {
  const { chatId, senderId, receiverId, content } = req.body;
  if (!chatId || !senderId || !receiverId || !content) {
    return res.status(400).json({ error: 'chatId, senderId, receiverId, content erforderlich' });
  }

  const { ciphertext, iv, authTag } = encrypt(content);
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  db.run(
    `
    INSERT INTO messages (id, chatId, senderId, receiverId, ciphertext, iv, authTag, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [id, chatId, senderId, receiverId, ciphertext, iv, authTag, createdAt],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Fehler beim Speichern der Nachricht' });
      }
      res.json({ ok: true, id });
    }
  );
});

// GET /api/messages?chatId=...&userId=...
// -> alle (noch vorhandenen) Nachrichten für diesen User in diesem Chat
app.get('/api/messages', (req, res) => {
  const { chatId, userId } = req.query;
  if (!chatId || !userId) {
    return res.status(400).json({ error: 'chatId und userId erforderlich' });
  }

  db.all(
    `
    SELECT * FROM messages
    WHERE chatId = ? AND receiverId = ?
    ORDER BY createdAt ASC
  `,
    [chatId, userId],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Fehler beim Laden der Nachrichten' });
      }

      // Entschlüsseln, damit der Browser Klartext bekommt.
      const decrypted = rows.map((row) => {
        let content = '';
        try {
          content = decrypt(row.ciphertext, row.iv, row.authTag);
        } catch (e) {
          console.error('Entschlüsselung fehlgeschlagen', e);
          content = '[Fehler bei Entschlüsselung]';
        }
        return {
          id: row.id,
          chatId: row.chatId,
          senderId: row.senderId,
          receiverId: row.receiverId,
          content,
          createdAt: row.createdAt,
        };
      });

      res.json(decrypted);
    }
  );
});

// POST /api/messages/:id/view  -> Nachricht "gesehen" -> wir löschen sie
app.post('/api/messages/:id/view', (req, res) => {
  const id = req.params.id;
  db.run(
    `
    DELETE FROM messages WHERE id = ?
  `,
    [id],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Fehler beim Löschen der Nachricht' });
      }
      res.json({ ok: true });
    }
  );
});

// ---------- Server starten ----------

app.listen(PORT, () => {
  console.log(`siso-Server läuft auf Port ${PORT}`);
});
