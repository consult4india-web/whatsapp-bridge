/**
 * whatsapp-server.js (multi-tenant edition)
 * -------------------------------------------
 * Hosts MULTIPLE independent WhatsApp sessions from a single running process.
 * Each session = one WhatsApp number = one Apps Script project (one Sheet).
 *
 * Instead of one hardcoded APPS_SCRIPT_URL/SHARED_SECRET, sessions are defined
 * in sessions.json:
 *   [
 *     { "id": "clientA", "appsScriptUrl": "...", "sharedSecret": "..." },
 *     { "id": "clientB", "appsScriptUrl": "...", "sharedSecret": "..." }
 *   ]
 *
 * Routes are per-session, keyed by the "id" in the path:
 *   GET /:sessionId/qr       -> QR PNG for that session
 *   GET /:sessionId/status   -> connection status for that session
 *
 * In each Apps Script project's Script Properties, set:
 *   NODE_SERVER_URL = https://<your-ngrok-or-host>/<sessionId>
 * (Code.gs / QrDialog.html don't need any changes — they already append
 * "/qr" and "/status" to whatever NODE_SERVER_URL is set to.)
 *
 * To add a new client project later: add an entry to sessions.json and
 * restart the server (or call POST /admin/reload with ADMIN_TOKEN, see below).
 *
 * RESILIENCE FEATURES IN THIS VERSION:
 *  - Auto-reconnect: if a session disconnects, it retries client.initialize()
 *    automatically after a short delay instead of staying dead.
 *  - Retrying webhook delivery: if a POST to Apps Script fails (network blip,
 *    Apps Script temporarily down), it retries a few times with backoff before
 *    giving up, so a transient failure doesn't silently drop a message.
 *  - Per-session isolation: an error in one session's Puppeteer/Chrome instance
 *    is caught and only restarts THAT session, not the whole process.
 *  - Run this under a process supervisor (PM2 recommended, see setup notes
 *    below) so the whole Node process restarts automatically if it ever dies.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const axios = require('axios');
const { Client, LocalAuth } = require('whatsapp-web.js');

// ---- Catch crashes that would otherwise exit silently ----
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // optional, protects /admin/reload
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const RECONNECT_DELAY_MS = 15000;

// In-memory state, keyed by session id.
// { client, latestQrPng, isConnected, connectedNumber, appsScriptUrl, sharedSecret }
const sessions = new Map();

function loadSessionConfigs() {
  if (!fs.existsSync(SESSIONS_FILE)) {
    console.error('sessions.json not found at', SESSIONS_FILE);
    return [];
  }
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('sessions.json must be a JSON array');
    return parsed;
  } catch (err) {
    console.error('Failed to parse sessions.json:', err.message);
    return [];
  }
}

// Retries a POST a few times with backoff before giving up, so a momentary
// Apps Script/network blip doesn't silently drop an incoming message.
async function postWithRetry(url, payload, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await axios.post(url, payload, { maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 20000 });
      return true;
    } catch (err) {
      console.error(`Webhook POST attempt ${i}/${attempts} failed:`, err.message);
      if (i < attempts) await new Promise(r => setTimeout(r, 2000 * i)); // 2s, 4s, ...
    }
  }
  console.error('All webhook POST attempts failed for', url, '- message was NOT delivered.');
  return false;
}

function startSession(config) {
  const { id, appsScriptUrl, sharedSecret } = config;

  if (!id || !appsScriptUrl || !sharedSecret) {
    console.error('Skipping invalid session config (needs id, appsScriptUrl, sharedSecret):', config);
    return;
  }

  console.log(`[${id}] starting session...`);

  const state = {
    client: null,
    latestQrPng: null,
    isConnected: false,
    connectedNumber: null,
    appsScriptUrl,
    sharedSecret
  };
  sessions.set(id, state);

  createClient(id, state);
}

function createClient(id, state) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }), // separate auth folder per session
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote'
      ]
    }
  });

  client.on('qr', async (qr) => {
    state.isConnected = false;
    const dataUrl = await QRCode.toDataURL(qr);
    state.latestQrPng = Buffer.from(dataUrl.split(',')[1], 'base64');
    console.log(`[${id}] New QR code ready.`);
  });

  client.on('ready', () => {
    state.isConnected = true;
    state.connectedNumber = client.info.wid.user;
    console.log(`[${id}] WhatsApp connected as`, state.connectedNumber);
  });

  client.on('disconnected', (reason) => {
    state.isConnected = false;
    state.connectedNumber = null;
    console.log(`[${id}] WhatsApp disconnected:`, reason, '- will retry in', RECONNECT_DELAY_MS / 1000, 's');
    scheduleReconnect(id, state);
  });

  client.on('message', async (msg) => {
    try {
      if (msg.isStatus || msg.from === 'status@broadcast') return;

      const chat = await msg.getChat();
      const isGroup = chat.isGroup;

      let senderName = '';
      try {
        const contact = await msg.getContact();
        senderName = contact.pushname || contact.name || contact.number || '';
      } catch (_) { /* ignore */ }

      const payload = {
        secret: state.sharedSecret,
        phone: state.connectedNumber,
        from: msg.from,
        chatName: chat.name || senderName || msg.from,
        chatType: isGroup ? 'group' : 'individual',
        senderNumber: msg.author || msg.from,
        senderName: senderName,
        type: msg.type,
        message: msg.body,
        id: msg.id.id,
        timestamp: msg.timestamp
      };

      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media && media.data) {
            const approxBytes = (media.data.length * 3) / 4;
            if (approxBytes <= MAX_MEDIA_BYTES) {
              payload.media = {
                mimetype: media.mimetype,
                data: media.data,
                filename: media.filename || ('wa_' + Date.now())
              };
            } else {
              const mb = Math.round(approxBytes / 1024 / 1024);
              payload.message = (payload.message ? payload.message + ' ' : '') + `[media skipped: ${mb}MB, over limit]`;
            }
          }
        } catch (mediaErr) {
          console.error(`[${id}] Failed to download media:`, mediaErr.message);
          payload.message = (payload.message ? payload.message + ' ' : '') + '[media download failed]';
        }
      }

      await postWithRetry(state.appsScriptUrl, payload);
    } catch (err) {
      console.error(`[${id}] Failed to handle/forward message:`, err.message);
    }
  });

  client.initialize().catch(err => {
    console.error(`[${id}] client.initialize() failed:`, err.message);
    scheduleReconnect(id, state);
  });

  state.client = client;
}

function scheduleReconnect(id, state) {
  if (state.reconnectScheduled) return; // avoid stacking multiple timers
  state.reconnectScheduled = true;
  setTimeout(() => {
    state.reconnectScheduled = false;
    console.log(`[${id}] attempting reconnect...`);
    try {
      if (state.client) state.client.destroy().catch(() => {});
    } catch (_) { /* ignore */ }
    createClient(id, state);
  }, RECONNECT_DELAY_MS);
}

function startAllSessions() {
  const configs = loadSessionConfigs();
  if (configs.length === 0) {
    console.error('No valid sessions configured — check sessions.json.');
  }
  configs.forEach(startSession);
}

startAllSessions();

// --- HTTP server ---
const app = express();
app.use(cors());
app.use(express.json());

app.get('/:sessionId/qr', (req, res) => {
  const state = sessions.get(req.params.sessionId);
  if (!state) return res.status(404).send('Unknown session id: ' + req.params.sessionId);
  if (!state.latestQrPng) return res.status(404).send('QR not ready yet — try again in a few seconds.');
  res.set('Content-Type', 'image/png');
  res.send(state.latestQrPng);
});

app.get('/:sessionId/status', (req, res) => {
  const state = sessions.get(req.params.sessionId);
  if (!state) return res.status(404).json({ connected: false, error: 'Unknown session id: ' + req.params.sessionId });
  res.json({ connected: state.isConnected, number: state.connectedNumber });
});

// Optional: lists configured sessions (ids only, no secrets) for a quick sanity check.
app.get('/admin/sessions', (req, res) => {
  const list = Array.from(sessions.entries()).map(([id, s]) => ({
    id, connected: s.isConnected, number: s.connectedNumber
  }));
  res.json(list);
});

// Optional: reload sessions.json without restarting the whole process — starts
// any newly-added sessions. Protect with ADMIN_TOKEN if you set one in .env.
app.post('/admin/reload', (req, res) => {
  if (ADMIN_TOKEN && req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(403).json({ ok: false, error: 'invalid admin token' });
  }
  const configs = loadSessionConfigs();
  let added = 0;
  configs.forEach(cfg => {
    if (!sessions.has(cfg.id)) {
      startSession(cfg);
      added++;
    }
  });
  res.json({ ok: true, added, total: sessions.size });
});

app.listen(PORT, () => console.log('Multi-tenant bridge server listening on port', PORT));