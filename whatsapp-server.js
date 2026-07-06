/**
 * whatsapp-server.js
 * -------------------
 * The missing piece Apps Script can't do itself: this connects to WhatsApp Web,
 * exposes the QR code + connection status over HTTP (so the Apps Script frontend
 * can display them), and forwards every incoming message to your Apps Script
 * webhook so it lands in Google Sheets.
 *
 * SETUP:
 *   npm init -y
 *   npm install whatsapp-web.js qrcode express axios
 *   node whatsapp-server.js
 *
 * This process must stay running (a laptop left on, a VPS, or a "background
 * worker" service like Render/Railway — NOT a serverless function, since it
 * needs a persistent browser session).
 *
 * NOTE: whatsapp-web.js is an unofficial library that automates WhatsApp Web via
 * a headless browser. It is not endorsed by WhatsApp/Meta and carries some risk
 * of the connected number being flagged. Use a number you're comfortable testing
 * with, and consider WhatsApp's official Cloud API for anything production-grade.
 */

const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const { Client, LocalAuth } = require('whatsapp-web.js');

// ---- CONFIG: fill these in ----
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const SHARED_SECRET = process.env.SHARED_SECRET;
const PORT = process.env.PORT || 3000;

let latestQrPng = null;   // Buffer of the current QR code as a PNG
let isConnected = false;
let connectedNumber = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '/data/.wwebjs_auth' }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', async (qr) => {
  isConnected = false;
  const dataUrl = await QRCode.toDataURL(qr);
  latestQrPng = Buffer.from(dataUrl.split(',')[1], 'base64');
  console.log('New QR code ready — open the Apps Script web app page to scan it.');
});

client.on('ready', () => {
  isConnected = true;
  connectedNumber = client.info.wid.user;
  console.log('WhatsApp connected as', connectedNumber);
});

client.on('disconnected', (reason) => {
  isConnected = false;
  connectedNumber = null;
  console.log('WhatsApp disconnected:', reason);
});

const MAX_MEDIA_BYTES = 15 * 1024 * 1024; // safety cap so huge videos don't blow up the webhook payload

client.on('message', async (msg) => {
  try {
    // Skip WhatsApp "Status" broadcast posts — not real chat messages.
    if (msg.isStatus || msg.from === 'status@broadcast') return;

    const chat = await msg.getChat();
    const isGroup = chat.isGroup;

    let senderName = '';
    try {
      const contact = await msg.getContact();
      senderName = contact.pushname || contact.name || contact.number || '';
    } catch (_) { /* ignore contact lookup failures */ }

    const payload = {
      secret: SHARED_SECRET,
      phone: connectedNumber,
      from: msg.from,
      chatName: chat.name || senderName || msg.from,
      chatType: isGroup ? 'group' : 'individual',
      senderNumber: msg.author || msg.from, // msg.author is the real sender inside a group
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
          const approxBytes = (media.data.length * 3) / 4; // base64 -> raw byte estimate
          if (approxBytes <= MAX_MEDIA_BYTES) {
            payload.media = {
              mimetype: media.mimetype,
              data: media.data, // base64 string
              filename: media.filename || ('wa_' + Date.now())
            };
          } else {
            const mb = Math.round(approxBytes / 1024 / 1024);
            payload.message = (payload.message ? payload.message + ' ' : '') + `[media skipped: ${mb}MB, over limit]`;
          }
        }
      } catch (mediaErr) {
        console.error('Failed to download media:', mediaErr.message);
        payload.message = (payload.message ? payload.message + ' ' : '') + '[media download failed]';
      }
    }

    await axios.post(APPS_SCRIPT_URL, payload, {
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });
  } catch (err) {
    console.error('Failed to forward message to Apps Script:', err.message);
  }
});

client.initialize();

// --- HTTP server: exposes QR + status for the Apps Script frontend to consume ---
const app = express();

app.get('/qr', (req, res) => {
  if (!latestQrPng) return res.status(404).send('QR not ready yet — try again in a few seconds.');
  res.set('Content-Type', 'image/png');
  res.send(latestQrPng);
});

app.get('/status', (req, res) => {
  res.json({ connected: isConnected, number: connectedNumber });
});

app.listen(PORT, () => console.log('Bridge server listening on port', PORT));