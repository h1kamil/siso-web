// server.js
// - Webserver (Express)
// - SQLite-DB: users, chats, messages
// - Verschlüsselung (AES-256-GCM)
// - 1-View-Messages
// - User-Anzeigenamen
// - Chats löschen
// - Admin-Dashboard (/api/admin/stats mit Admin-Code)
// - Namenssuche (/api/users/find) – case-insensitive, Teilstrings

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- DB ----------

const db = new sqlite3.Database(path.join(__dirname, 'siso.db'));

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      displayName TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      userAId TEXT NOT NULL,
      userBId TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);

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

const SECRET_KEY = crypto
  .createHash('sha256')
  .update('siso-super-secret-key')
  .digest(); // 32 Byte

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
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

// ---------- User-Profile ----------

// Name setzen/ändern
app.post('/api/users/profile', (req, res) => {
  const { userId, displayName } = req.body;
  if (!userId || typeof displayName !== 'string') {
    return res.status(400).json({ error: 'userId und displayName erforderlich' });
  }
  const trimmed = displayName.trim();
  if (!trimmed) {
    return res.status(400).json({ error: 'displayName darf nicht leer sein' });
  }

  const now = Date.now();

  db.run(
    `
    INSERT INTO users (id, displayName, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      displayName = excluded.displayName,
      updatedAt = excluded.updatedAt
  `,
    [userId, trimmed, now],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Fehler beim Speichern des Anzeigenamens' });
      }
      res.json({ ok: true });
    }
  );
});

// Namen mehrerer User holen (für Chat-Liste etc.)
app.get('/api/users', (req, res) => {
  const idsParam = req.query.ids;
  if (!idsParam) {
    return res.status(400).json({ error: 'ids-Parameter erforderlich' });
  }
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return res.json([]);
  }

  const placeholders = ids.map(() => '?').join(',');
  db.all(
    `
    SELECT id, displayName, updatedAt
    FROM users
    WHERE id IN (${placeholders})
  `,
    ids,
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Fehler beim Laden der Benutzerprofile' });
      }
      res.json(rows);
    }
  );
});

// Namenssuche (case-insensitive, Teilstrings)
// GET /api/users/find?q=User
// -> [{ id, displayName }]
app.get('/api/users/find', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'q-Parameter erforderlich' });
  }

  const like = `%${q.toLowerCase()}%`;

  db.all(
    `
    SELECT id, displayName
    FROM users
    WHERE LOWER(displayName) LIKE ?
    ORDER BY updatedAt DESC
    LIMIT 10
  `,
    [like],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Fehler bei der Namenssuche' });
      }
      res.json(rows);
    }
  );
});

// ---------- Chats ----------

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
      if (row) return callback(null, row.id);

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

// Chat + Nachrichten löschen
app.delete('/api/chats/:id', (req, res) => {
  const chatId = req.params.id;
  const userId = req.query.userId;

  if (!userId) {
    return res.status(400).json({ error: 'userId erforderlich' });
  }

  db.get(
    `
    SELECT * FROM chats
    WHERE id = ? AND (userAId = ? OR userBId = ?)
  `,
    [chatId, userId, userId],
    (err, chat) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Fehler beim Prüfen des Chats' });
      }
      if (!chat) {
        return res.status(403).json({ error: 'Kein Zugriff auf diesen Chat' });
      }

      db.run(`DELETE FROM messages WHERE chatId = ?`, [chatId], (err2) => {
        if (err2) {
          console.error(err2);
          return res.status(500).json({ error: 'Fehler beim Löschen der Nachrichten' });
        }

        db.run(`DELETE FROM chats WHERE id = ?`, [chatId], (err3) => {
          if (err3) {
            console.error(err3);
            return res.status(500).json({ error: 'Fehler beim Löschen des Chats' });
          }
          res.json({ ok: true });
        });
      });
    }
  );
});

// ---------- Nachrichten ----------

app.post('/api/messages', (req, res) => {
  const { chatId, senderId, receiverId, content } = req.body;
  if (!chatId || !senderId || !receiverId || !content) {
    return res
      .status(400)
      .json({ error: 'chatId, senderId, receiverId, content erforderlich' });
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

// ---------- Admin-Dashboard ----------
// POST /api/admin/stats
// Body: { adminCode, userId }

app.post('/api/admin/stats', (req, res) => {
  const { adminCode, userId } = req.body || {};
  const expected = process.env.ADMIN_CODE || 'changeme-admin';

  if (!adminCode || adminCode !== expected) {
    return res.status(403).json({ error: 'Nicht berechtigt (Admin-Code falsch)' });
  }

  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  db.get(`SELECT COUNT(*) AS cnt FROM users`, (err1, rowUsers) => {
    if (err1) {
      console.error(err1);
      return res.status(500).json({ error: 'Fehler bei User-Statistik' });
    }

    db.get(`SELECT COUNT(*) AS cnt FROM chats`, (err2, rowChats) => {
      if (err2) {
        console.error(err2);
        return res.status(500).json({ error: 'Fehler bei Chat-Statistik' });
      }

      db.get(`SELECT COUNT(*) AS cnt FROM messages`, (err3, rowMessages) => {
        if (err3) {
          console.error(err3);
          return res.status(500).json({ error: 'Fehler bei Nachrichten-Statistik' });
        }

        db.get(
          `SELECT COUNT(*) AS cnt FROM messages WHERE createdAt >= ?`,
          [oneDayAgo],
          (err4, row24h) => {
            if (err4) {
              console.error(err4);
              return res.status(500).json({ error: 'Fehler bei 24h-Statistik' });
            }

            db.get(
              `SELECT COUNT(*) AS cnt FROM messages WHERE createdAt >= ?`,
              [sevenDaysAgo],
              (err5, row7d) => {
                if (err5) {
                  console.error(err5);
                  return res.status(500).json({ error: 'Fehler bei 7-Tage-Statistik' });
                }

                if (!userId) {
                  return res.json({
                    userCount: rowUsers.cnt,
                    chatCount: rowChats.cnt,
                    messageCount: rowMessages.cnt,
                    messagesLast24h: row24h.cnt,
                    messagesLast7d: row7d.cnt,
                    mySentMessages: null,
                  });
                }

                db.get(
                  `SELECT COUNT(*) AS cnt FROM messages WHERE senderId = ?`,
                  [userId],
                  (err6, rowMyMsgs) => {
                    if (err6) {
                      console.error(err6);
                      return res.status(500).json({
                        error: 'Fehler bei persönlichen Nachrichten-Statistik',
                      });
                    }

                    res.json({
                      userCount: rowUsers.cnt,
                      chatCount: rowChats.cnt,
                      messageCount: rowMessages.cnt,
                      messagesLast24h: row24h.cnt,
                      messagesLast7d: row7d.cnt,
                      mySentMessages: rowMyMsgs.cnt,
                    });
                  }
                );
              }
            );
          }
        );
      });
    });
  });
});

// ---------- Server ----------

app.listen(PORT, () => {
  console.log(`siso-Server läuft auf Port ${PORT}`);
});
