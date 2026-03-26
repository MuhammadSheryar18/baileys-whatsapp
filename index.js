const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");

const app = express();
app.use(express.json());

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

const sessions = {};
const fs = require("fs");
const path = require("path");

// Clean old corrupted sessions on startup
const dirs = fs.readdirSync(".").filter(d => d.startsWith("auth_"));
dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true }));
console.log(`Cleaned ${dirs.length} old session(s)`);

function auth(req, res, next) {
  if (WEBHOOK_SECRET && req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function notifySupabase(path, body) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": WEBHOOK_SECRET,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify(body),
    });
    console.log(`Notified ${path}: ${res.status}`);
  } catch (err) {
    console.error("Supabase notify error:", err.message);
  }
}

async function startSession(tenant_id) {
  const authDir = `./auth_${tenant_id}`;
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    logger: pino({ level: "silent" }),
    browser: ["WA2GHL", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: false,
  });

  sessions[tenant_id] = { sock, qr: null, status: "connecting" };

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ qr, connection, lastDisconnect }) => {
    if (qr) {
      console.log(`[${tenant_id}] QR received`);
      sessions[tenant_id].qr = qr;
      sessions[tenant_id].status = "waiting_scan";
    }
    if (connection === "open") {
      console.log(`[${tenant_id}] Connected!`);
      sessions[tenant_id].status = "connected";
      sessions[tenant_id].qr = null;
      const phone = sock.user?.id?.split(":")[0];
      await notifySupabase("whatsapp-session-update", {
        tenant_id,
        status: "connected",
        phone_number: phone,
      });
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[${tenant_id}] Disconnected. Code: ${statusCode}. Reconnect: ${shouldReconnect}`);
      delete sessions[tenant_id];
      if (shouldReconnect) {
        console.log(`[${tenant_id}] Reconnecting in 3s...`);
        setTimeout(() => startSession(tenant_id), 3000);
      } else {
        await notifySupabase("whatsapp-session-update", {
          tenant_id,
          status: "disconnected",
        });
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";
      if (!text) continue;
      await notifySupabase("whatsapp-inbound", {
        tenant_id,
        from: msg.key.remoteJid?.replace("@s.whatsapp.net", ""),
        message: text,
        pushName: msg.pushName || "",
        messageId: msg.key.id,
      });
    }
  });

  return sock;
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/session/start", auth, async (req, res) => {
  const { tenant_id } = req.body;
  if (!tenant_id) return res.status(400).json({ error: "tenant_id required" });
  if (sessions[tenant_id]) return res.json({ status: "already_started" });
  try {
    await startSession(tenant_id);
    res.json({ status: "started" });
  } catch (err) {
    console.error(`[${tenant_id}] Start error:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/session/qr/:tenant_id", auth, async (req, res) => {
  const s = sessions[req.params.tenant_id];
  if (!s) return res.json({ qr: null, status: "inactive" });
  if (!s.qr) return res.json({ qr: null, status: s.status });
  try {
    const dataUrl = await QRCode.toDataURL(s.qr);
    res.json({ qr: dataUrl, status: s.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/session/status/:tenant_id", auth, (req, res) => {
  const s = sessions[req.params.tenant_id];
  res.json({ status: s?.status || "inactive" });
});

app.post("/session/disconnect", auth, async (req, res) => {
  const { tenant_id } = req.body;
  if (sessions[tenant_id]) {
    try { sessions[tenant_id].sock.end(); } catch (e) {}
    delete sessions[tenant_id];
  }
  res.json({ status: "disconnected" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Baileys server running on port ${PORT}`));
