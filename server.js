'use strict';

/**
 * F7 Car Care — WhatsApp Cloud API + Claude support bot
 * Node.js 20.6+ · only dependency: express
 *
 * Flow:  Customer -> WhatsApp -> Meta -> POST /webhook -> (verify signature, 200 OK instantly)
 *        -> batch rapid messages -> Claude -> reply via Graph API -> (optional) Telegram alert to owner
 */

const crypto = require('node:crypto');
const express = require('express');
const { BUSINESS, buildSystemPrompt } = require('./knowledge');

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
const env = process.env;

const CONFIG = {
  port: Number(env.PORT) || 3000,

  // Meta / WhatsApp
  waToken: env.WHATSAPP_TOKEN, // System User token (never-expiring)
  phoneNumberId: env.PHONE_NUMBER_ID,
  appSecret: env.APP_SECRET, // App Dashboard > Settings > Basic
  verifyToken: env.VERIFY_TOKEN, // any long random string you invent
  graphVersion: env.GRAPH_VERSION || 'v25.0',

  // Claude
  anthropicKey: env.ANTHROPIC_API_KEY,
  model: env.CLAUDE_MODEL || 'claude-haiku-5-5',

  // Owner alerts (optional)
  telegramToken: env.TELEGRAM_BOT_TOKEN,
  telegramChat: env.TELEGRAM_CHAT_ID,

  // Behaviour
  enabled: (env.BOT_ENABLED || 'true').toLowerCase() !== 'false', // kill switch
  debounceMs: Number(env.DEBOUNCE_MS) || 2500, // wait for rapid-fire messages, reply once
  maxHistory: Number(env.MAX_HISTORY) || 12, // messages of memory per customer
  humanPauseMs: (Number(env.HUMAN_PAUSE_MINUTES) || 180) * 60_000,
  maxMsgsPer10Min: Number(env.MAX_MSGS_PER_10_MIN) || 30, // anti-spam / cost guard
};

const REQUIRED = ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'APP_SECRET', 'VERIFY_TOKEN', 'ANTHROPIC_API_KEY'];
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const FALLBACK_REPLY =
  `Sorry, I'm having a small technical issue right now 🙏 Our team will get back to you shortly.\n\n` +
  `📍 ${BUSINESS.address}\n${BUSINESS.maps}`;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (n) => String(n).replace(/\d(?=\d{4})/g, '*'); // keep last 4 digits in logs
const cleanName = (n) => String(n).replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40).trim();
const nowInUAE = () =>
  new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'full', timeStyle: 'short' });

/** Claude writes Markdown; WhatsApp uses *bold*. Also enforce the 4096-char limit. */
function toWhatsApp(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

/* ------------------------------------------------------------------ */
/* WhatsApp Cloud API (Graph API)                                      */
/* ------------------------------------------------------------------ */
async function graph(path, payload, attempt = 1) {
  const url = `https://graph.facebook.com/${CONFIG.graphVersion}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CONFIG.waToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    if (attempt < 3) {
      await sleep(500 * 2 ** attempt);
      return graph(path, payload, attempt + 1);
    }
    throw err;
  }
  if (res.ok) return res.json();

  const body = await res.text();
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleep(1000 * 2 ** attempt);
    return graph(path, payload, attempt + 1);
  }
  throw new Error(`Graph API ${res.status}: ${body}`);
}

const sendText = (to, body) =>
  graph(`/${CONFIG.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: true, body }, // preview_url shows the Google Maps card
  });

/** Blue ticks + "typing…" bubble while the AI thinks. Cosmetic, so failures are ignored. */
const markReadAndType = (messageId) =>
  graph(`/${CONFIG.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
    typing_indicator: { type: 'text' },
  }).catch(() => {});

/* ------------------------------------------------------------------ */
/* Claude                                                              */
/* ------------------------------------------------------------------ */
async function askClaude(session) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': CONFIG.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CONFIG.model,
        max_tokens: 500,
        system: buildSystemPrompt({ customerName: session.name, now: nowInUAE() }),
        messages: session.history,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) {
      const data = await res.json();
      return (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(1500);
      continue;
    }
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }
}

/* ------------------------------------------------------------------ */
/* Owner alerts (Telegram — optional, free)                            */
/* ------------------------------------------------------------------ */
async function alertOwner(kind, text) {
  console.log(`[ALERT:${kind}]`);
  if (!CONFIG.telegramToken || !CONFIG.telegramChat) return;
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.telegramChat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error('Telegram alert failed:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Per-customer sessions (in memory — see README note on persistence)  */
/* ------------------------------------------------------------------ */
const sessions = new Map(); // wa_id -> session
const seen = new Map(); // message id -> first-seen timestamp (Meta retries webhooks)

function getSession(waId) {
  let s = sessions.get(waId);
  if (!s) {
    s = {
      history: [], // [{role:'user'|'assistant', content}] — alternating, starts with user
      pending: [], // texts waiting for the debounce timer
      timer: null,
      busy: false,
      pausedUntil: 0,
      hits: [],
      lastLeadAt: 0,
      lastSeen: Date.now(),
      name: '',
    };
    sessions.set(waId, s);
  }
  s.lastSeen = Date.now();
  return s;
}

/** Keeps roles alternating (Claude requires it) and memory bounded. */
function pushHistory(s, role, content) {
  const last = s.history[s.history.length - 1];
  if (last && last.role === role) last.content += `\n${content}`;
  else s.history.push({ role, content });
  while (s.history.length > CONFIG.maxHistory) s.history.shift();
  while (s.history.length && s.history[0].role !== 'user') s.history.shift();
}

function rateLimited(s) {
  const now = Date.now();
  s.hits = s.hits.filter((t) => now - t < 600_000);
  s.hits.push(now);
  return s.hits.length > CONFIG.maxMsgsPer10Min;
}

function transcriptTail(s, n = 6) {
  return s.history
    .slice(-n)
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Bot'}: ${m.content}`)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Message handling                                                    */
/* ------------------------------------------------------------------ */
function extractText(m) {
  switch (m.type) {
    case 'text':
      return m.text?.body || '';
    case 'button':
      return m.button?.text || m.button?.payload || '';
    case 'interactive':
      return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
    case 'image':
      return `[The customer sent a photo${m.image?.caption ? ` with caption: "${m.image.caption}"` : ''}. You cannot see images.]`;
    case 'video':
      return '[The customer sent a video. You cannot watch videos.]';
    case 'audio':
      return '[The customer sent a voice note. You cannot listen to voice notes.]';
    case 'document':
      return '[The customer sent a file. You cannot open files.]';
    case 'location':
      return `[The customer shared a location: ${m.location?.latitude}, ${m.location?.longitude}]`;
    default:
      return ''; // reactions, stickers, edits, revokes, unsupported… are ignored
  }
}

function onIncoming(m, profileName) {
  if (!CONFIG.enabled) return;
  if (!m?.id || seen.has(m.id)) return; // duplicate delivery
  seen.set(m.id, Date.now());

  const text = extractText(m).trim();
  if (!text) return;

  const s = getSession(m.from);
  if (profileName) s.name = cleanName(profileName); // sanitised: it goes into the prompt

  if (Date.now() < s.pausedUntil) {
    console.log(`[paused] human is handling ${mask(m.from)}`);
    return;
  }
  if (rateLimited(s)) {
    console.warn(`[rate-limit] dropping message from ${mask(m.from)}`);
    return;
  }

  markReadAndType(m.id);
  s.pending.push(text);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => flush(m.from), CONFIG.debounceMs);
}

/** Coexistence only: the owner replied from the WhatsApp Business app -> bot stays quiet for a while. */
function onEcho(e) {
  if (!e?.to) return;
  const s = getSession(e.to);
  s.pausedUntil = Date.now() + CONFIG.humanPauseMs;
  clearTimeout(s.timer);
  s.pending = [];
  console.log(`[human takeover] bot paused for ${mask(e.to)}`);
}

async function flush(waId) {
  const s = sessions.get(waId);
  if (!s || s.busy || !s.pending.length) return;
  s.busy = true;

  try {
    pushHistory(s, 'user', s.pending.splice(0).join('\n'));

    let raw;
    try {
      raw = await askClaude(s);
    } catch (err) {
      console.error(`[claude] ${err.message}`);
      await sendText(waId, FALLBACK_REPLY);
      await alertOwner('error', `⚠️ Bot could not answer a customer.\nhttps://wa.me/${waId}\n\n${transcriptTail(s)}`);
      return;
    }

    const wantsHuman = /\[\[HUMAN\]\]/i.test(raw);
    const isLead = /\[\[LEAD\]\]/i.test(raw);
    const reply = toWhatsApp(raw.replace(/\[\[(?:HUMAN|LEAD)\]\]/gi, ''));

    if (reply) {
      await sendText(waId, reply);
      pushHistory(s, 'assistant', reply);
      console.log(`[reply] sent to ${mask(waId)} (${reply.length} chars)`);
    }

    if (isLead && Date.now() - s.lastLeadAt > 30 * 60_000) {
      s.lastLeadAt = Date.now();
      await alertOwner(
        'lead',
        `🟢 NEW BOOKING REQUEST\nCustomer: ${s.name || 'unknown'} (+${waId})\nOpen chat: https://wa.me/${waId}\n\n${transcriptTail(s)}`
      );
    } else if (wantsHuman) {
      await alertOwner(
        'human',
        `🔴 CUSTOMER NEEDS A HUMAN\nCustomer: ${s.name || 'unknown'} (+${waId})\nOpen chat: https://wa.me/${waId}\n\n${transcriptTail(s)}`
      );
    }
  } catch (err) {
    console.error(`[flush] ${err.message}`);
  } finally {
    s.busy = false;
    if (s.pending.length) {
      clearTimeout(s.timer);
      s.timer = setTimeout(() => flush(waId), CONFIG.debounceMs);
    }
  }
}

function handleWebhook(body) {
  if (body?.object !== 'whatsapp_business_account') return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (v.metadata?.phone_number_id && v.metadata.phone_number_id !== CONFIG.phoneNumberId) continue;

      if (change.field === 'messages') {
        const names = {};
        for (const c of v.contacts || []) names[c.wa_id] = c.profile?.name;
        for (const m of v.messages || []) onIncoming(m, names[m.from]);
      } else if (change.field === 'smb_message_echoes') {
        for (const e of v.message_echoes || []) onEcho(e);
      }
      // delivery/read "statuses" arrive in v.statuses — ignored on purpose
    }
  }
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */
function validSignature(req) {
  const received = req.get('x-hub-signature-256') || '';
  const expected = `sha256=${crypto.createHmac('sha256', CONFIG.appSecret).update(req.rawBody || '').digest('hex')}`;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const app = express();
app.disable('x-powered-by');
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf; // needed for the HMAC signature check
    },
  })
);

// Health check (Render pings this; also handy in a browser)
app.get('/', (_req, res) => res.status(200).send(`${BUSINESS.name} WhatsApp bot is running`));

// Meta calls this once when you click "Verify and save" in the App Dashboard
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === CONFIG.verifyToken) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Meta delivers every customer message here
app.post('/webhook', (req, res) => {
  if (!validSignature(req)) {
    console.warn('Rejected webhook with invalid signature');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // answer Meta immediately; the AI work happens in the background
  try {
    handleWebhook(req.body);
  } catch (err) {
    console.error('handleWebhook error:', err);
  }
});

const server = app.listen(CONFIG.port, () => {
  console.log(`${BUSINESS.name} bot listening on :${CONFIG.port} | model=${CONFIG.model} | graph=${CONFIG.graphVersion} | enabled=${CONFIG.enabled}`);
});

// Housekeeping: free memory for idle customers and old message ids
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (!s.busy && now - s.lastSeen > 24 * 3_600_000) sessions.delete(id);
  for (const [id, t] of seen) if (now - t > 3_600_000) seen.delete(id);
}, 10 * 60_000).unref();

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('SIGTERM', () => server.close(() => process.exit(0))); // Render sends SIGTERM on redeploy
