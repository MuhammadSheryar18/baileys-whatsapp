const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const express = require("express");
const QRCode = require("qrcode");
const app = express();
app.use(express.json());

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

const sessions = {};

function auth(req, res, next) {
  if (WEBHOOK_SECRET && req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function notifySupabase(path, body) {
  await fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-webhook-secret": WEBHOOK_SECRET },
    body: JSON.stringify(body),
  });
}

app.post("/session/start", auth, async (req, res) => {
  const { tenant_id } = req.body;
  if (sessions[tenant_id]) return res.json({ status: "already_started" });

  const { state, saveCreds } = await useMultiFileAuthState(`./auth_${tenant_id}`);
  const sock = makeWASocket({ auth: state, printQRInTerminal: true });

  sessions[tenant_id] = { sock, qr: null };

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async ({ qr, connection, lastDisconnect }) => {
    if (qr) sessions[tenant_id].qr = qr;
    if (connection === "open") {
      const phone = sock.user?.id?.split(":")[0];
      await notifySupabase("whatsapp-session-update", { tenant_id, status: "connected", phone_number: phone });
    }
    if (connection === "close") {
      delete sessions[tenant_id];
      await notifySupabase("whatsapp-session-update", { tenant_id, status: "disconnected" });
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      await notifySupabase("whatsapp-inbound", {
        tenant_id,
        from: msg.key.remoteJid,
        message: msg.message.conversation || msg.message.extendedTextMessage?.text || "",
        pushName: msg.pushName || "",
        messageId: msg.key.id,
      });
    }
  });

  res.json({ status: "started" });
});

app.get("/session/qr/:tenant_id", auth, async (req, res) => {
  const s = sessions[req.params.tenant_id];
  if (!s?.qr) return res.json({ qr: null });
  const dataUrl = await QRCode.toDataURL(s.qr);
  res.json({ qr: dataUrl });
});

app.get("/session/status/:tenant_id", auth, (req, res) => {
  const s = sessions[req.params.tenant_id];
  res.json({ status: s ? "active" : "inactive" });
});

app.post("/session/disconnect", auth, (req, res) => {
  const { tenant_id } = req.body;
  if (sessions[tenant_id]) { sessions[tenant_id].sock.end(); delete sessions[tenant_id]; }
  res.json({ status: "disconnected" });
});

app.listen(process.env.PORT || 3000, () => console.log("Baileys server running"));
