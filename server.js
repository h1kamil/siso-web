// server.js
// - Webserver (Express)
// - Supabase Postgres statt SQLite
// - Verschlüsselung (AES-256-GCM)
// - 1-View-Messages
// - User-Anzeigenamen
// - Chats löschen
// - Admin-Dashboard (/api/admin/stats mit Admin-Code)
// - Namenssuche (/api/users/find) – case-insensitive, Teilstrings
// - Admin-Userliste (/api/admin/users) – nur mit Admin-Code

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- DB-Verbindung zu Supabase (Postgres) ----------

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Fehler: SUPABASE_DB_URL ist nicht gesetzt!');
}

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false, // nötig für viele gehostete Postgres-Instanzen (Supabase)
  },
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

// Tabellen anlegen (falls sie noch nicht existieren)
async function initDb() {
  // users: id, displayname, updatedat
  await query(
    `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      displayname TEXT NOT NULL,
      updatedat BIGINT NOT NULL
    )
  `,
    []
  );

  // chats: id, user_a_id, user_b_id, created_at
  await query(
    `
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      user_a_id TEXT NOT NULL,
      user_b_id TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `,
    []
  );

  // messages: id, chat_id, sender_id, receiver_id, ciphertext, iv, auth_tag, created_at
  await query(
    `
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `,
    []
  );

  console.log('Datenbanktabellen (users, chats, messages) initialisiert.');
}

// ---------- Express-Basis ----------

app.use(express.json({ limit: '5mb' })); // für Base64-Bilder
app.use(express.static(path.join(__dirname, 'public')));

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
app.post('/api/users/profile', async (req, res) => {
  const { userId, displayName } = req.body;
  if (!userId || typeof displayName !== 'string') {
    return res.status(400).json({ error: 'userId und displayName erforderlich' });
  }
  const trimmed = displayName.trim();
  if (!trimmed) {
    return res.status(400).json({ error: 'displayName darf nicht leer sein' });
  }

  const now = Date.now();

  try {
    await query(
      `
      INSERT INTO users (id, displayname, updatedat)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET
        displayname = EXCLUDED.displayname,
        updatedat = EXCLUDED.updatedat
    `,
      [userId, trimmed, now]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Speichern des Anzeigenamens' });
  }
});

// Namen mehrerer User holen (für Chat-Liste etc.)
app.get('/api/users', async (req, res) => {
  const idsParam = req.query.ids;
  if (!idsParam) {
    return res.status(400).json({ error: 'ids-Parameter erforderlich' });
  }
  const ids = idsParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return res.json([]);
  }

  try {
    const result = await query(
      `
      SELECT id,
             displayname AS "displayName",
             updatedat   AS "updatedAt"
      FROM users
      WHERE id = ANY($1)
    `,
      [ids]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Laden der Benutzerprofile' });
  }
});

// Namenssuche (case-insensitive, Teilstrings)
app.get('/api/users/find', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'q-Parameter erforderlich' });
  }

  const like = `%${q.toLowerCase()}%`;

  try {
    const result = await query(
      `
      SELECT id,
             displayname AS "displayName",
             updatedat   AS "updatedAt"
      FROM users
      WHERE LOWER(displayname) LIKE $1
      ORDER BY updatedat DESC
      LIMIT 10
    `,
      [like]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler bei der Namenssuche' });
  }
});

// ---------- Chats ----------

async function ensureChat(myUserId, otherUserId) {
  // Prüfen, ob Chat schon existiert
  const result = await query(
    `
    SELECT id
    FROM chats
    WHERE (user_a_id = $1 AND user_b_id = $2)
       OR (user_a_id = $2 AND user_b_id = $1)
  `,
    [myUserId, otherUserId]
  );

  if (result.rows.length > 0) {
    return result.rows[0].id;
  }

  // sonst neu anlegen
  const chatId = crypto.randomUUID();
  const createdAt = Date.now();

  await query(
    `
    INSERT INTO chats (id, user_a_id, user_b_id, created_at)
    VALUES ($1, $2, $3, $4)
  `,
    [chatId, myUserId, otherUserId, createdAt]
  );

  return chatId;
}

app.post('/api/chats', async (req, res) => {
  const { myUserId, otherUserId } = req.body;
  if (!myUserId || !otherUserId) {
    return res.status(400).json({ error: 'myUserId und otherUserId sind erforderlich' });
  }
  if (myUserId === otherUserId) {
    return res.status(400).json({ error: 'Mit dir selbst chatten ergibt keinen Sinn 😉' });
  }

  try {
    const chatId = await ensureChat(myUserId, otherUserId);
    res.json({ chatId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Anlegen des Chats' });
  }
});

app.get('/api/chats', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId erforderlich' });

  try {
    const result = await query(
      `
      SELECT id,
             user_a_id AS "userAId",
             user_b_id AS "userBId",
             created_at AS "createdAt"
      FROM chats
      WHERE user_a_id = $1 OR user_b_id = $1
      ORDER BY created_at DESC
    `,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Laden der Chats' });
  }
});

// Chat + Nachrichten löschen
app.delete('/api/chats/:id', async (req, res) => {
  const chatId = req.params.id;
  const userId = req.query.userId;

  if (!userId) {
    return res.status(400).json({ error: 'userId erforderlich' });
  }

  try {
    const result = await query(
      `
      SELECT id
      FROM chats
      WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)
    `,
      [chatId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Kein Zugriff auf diesen Chat' });
    }

    await query(`DELETE FROM messages WHERE chat_id = $1`, [chatId]);
    await query(`DELETE FROM chats WHERE id = $1`, [chatId]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Löschen des Chats' });
  }
});

// ---------- Nachrichten ----------

app.post('/api/messages', async (req, res) => {
  const { chatId, senderId, receiverId, content } = req.body;
  if (!chatId || !senderId || !receiverId || !content) {
    return res
      .status(400)
      .json({ error: 'chatId, senderId, receiverId, content erforderlich' });
  }

  const { ciphertext, iv, authTag } = encrypt(content);
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  try {
    await query(
      `
      INSERT INTO messages (id, chat_id, sender_id, receiver_id, ciphertext, iv, auth_tag, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
      [id, chatId, senderId, receiverId, ciphertext, iv, authTag, createdAt]
    );
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Speichern der Nachricht' });
  }
});

app.get('/api/messages', async (req, res) => {
  const { chatId, userId } = req.query;
  if (!chatId || !userId) {
    return res.status(400).json({ error: 'chatId und userId erforderlich' });
  }

  try {
    const result = await query(
      `
      SELECT id,
             chat_id    AS "chatId",
             sender_id  AS "senderId",
             receiver_id AS "receiverId",
             ciphertext,
             iv,
             auth_tag   AS "authTag",
             created_at AS "createdAt"
      FROM messages
      WHERE chat_id = $1 AND receiver_id = $2
      ORDER BY created_at ASC
    `,
      [chatId, userId]
    );

    const decrypted = result.rows.map((row) => {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Laden der Nachrichten' });
  }
});

app.post('/api/messages/:id/view', async (req, res) => {
  const id = req.params.id;
  try {
    await query(`DELETE FROM messages WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Löschen der Nachricht' });
  }
});

// ---------- Admin-Dashboard ----------

app.post('/api/admin/stats', async (req, res) => {
  const { adminCode, userId } = req.body || {};
  const expected = process.env.ADMIN_CODE || 'changeme-admin';

  if (!adminCode || adminCode !== expected) {
    return res.status(403).json({ error: 'Nicht berechtigt (Admin-Code falsch)' });
  }

  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  try {
    const usersRes = await query(`SELECT COUNT(*)::int AS cnt FROM users`, []);
    const chatsRes = await query(`SELECT COUNT(*)::int AS cnt FROM chats`, []);
    const msgsRes = await query(`SELECT COUNT(*)::int AS cnt FROM messages`, []);
    const msgs24hRes = await query(
      `SELECT COUNT(*)::int AS cnt FROM messages WHERE created_at >= $1`,
      [oneDayAgo]
    );
    const msgs7dRes = await query(
      `SELECT COUNT(*)::int AS cnt FROM messages WHERE created_at >= $1`,
      [sevenDaysAgo]
    );

    let mySentMessages = null;
    if (userId) {
      const myRes = await query(
        `SELECT COUNT(*)::int AS cnt FROM messages WHERE sender_id = $1`,
        [userId]
      );
      mySentMessages = myRes.rows[0].cnt;
    }

    res.json({
      userCount: usersRes.rows[0].cnt,
      chatCount: chatsRes.rows[0].cnt,
      messageCount: msgsRes.rows[0].cnt,
      messagesLast24h: msgs24hRes.rows[0].cnt,
      messagesLast7d: msgs7dRes.rows[0].cnt,
      mySentMessages,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler bei Admin-Statistiken' });
  }
});

// ---------- Admin: Userliste ----------

app.get('/api/admin/users', async (req, res) => {
  const adminCode = req.headers['x-admin-code'];
  const expected = process.env.ADMIN_CODE || 'changeme-admin';

  if (!adminCode || adminCode !== expected) {
    return res.status(403).json({ error: 'Nicht berechtigt' });
  }

  try {
    const result = await query(
      `
      SELECT id,
             displayname AS "displayName",
             updatedat   AS "updatedAt"
      FROM users
      ORDER BY updatedat DESC
    `,
      []
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Laden der Userliste' });
  }
});

// ---------- Serverstart ----------

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`siso-Server läuft auf Port ${PORT} (Supabase-DB)`);
    });
  })
  .catch((err) => {
    console.error('Fehler bei initDb:', err);
    // trotzdem starten, aber ohne DB wird es Fehler geben
    app.listen(PORT, () => {
      console.log(`siso-Server läuft auf Port ${PORT}, aber initDb ist fehlgeschlagen`);
    });
  });
