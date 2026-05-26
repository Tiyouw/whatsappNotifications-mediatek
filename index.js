require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { startScheduler } = require("./src/scheduler");
const { handleCommand, handleReaction } = require("./src/commandHandler");
const { startDashboardServer } = require("./src/dashboardServer");
const { startInstagramMonitor } = require("./src/instagramMonitor");
const { startFormMonitor } = require("./src/formMonitor");
const {
  convertImageToSticker,
  convertVideoToSticker,
  getMediaBuffer,
  getMediaCaption,
  getMediaType,
  getMimeType,
} = require("./src/stickerHandler");

// ── Production-safe runtime path resolution ────────────────────────────
// AUTH_DIR is the Baileys session folder. Locally it defaults to the
// relative path "auth_info_baileys" to preserve pre-migration dev behavior.
// On Fly.io it must be set (via fly.toml [env]) to an absolute path on the
// mounted volume, typically /data/auth_info_baileys. If this check is
// skipped and AUTH_DIR is missing or non-absolute in production, Baileys
// would silently create a fresh session inside the ephemeral /app
// filesystem and print a QR in the logs, which is unrecoverable because
// the linked phone is no longer available to scan a new QR. Fail fast
// here, at module load, before Baileys or the HTTP keep-alive ever starts.
const AUTH_DIR = process.env.AUTH_DIR || "auth_info_baileys";
if (process.env.NODE_ENV === "production") {
  if (!process.env.AUTH_DIR || !path.isAbsolute(AUTH_DIR)) {
    console.error(
      `❌ FATAL: AUTH_DIR must be set to an absolute path when NODE_ENV=production ` +
      `(got ${JSON.stringify(process.env.AUTH_DIR)}). ` +
      `Check fly.toml [env] and run \`flyctl secrets list\` to confirm no secret ` +
      `is shadowing it. Refusing to start to avoid creating a fresh WhatsApp ` +
      `session on the ephemeral filesystem and printing a QR nobody can scan.`
    );
    process.exit(1);
  }
}

const logger = pino({ level: "silent" });

let sock = null;
let schedulerStarted = false;
let igMonitorStarted = false;
let formMonitorStarted = false;
let isFirstConnect = true;
let reconnectCount = 0;

startDashboardServer(() => sock);

// lid → phone number map, built from contacts events
// e.g. { "125812544147601@lid": "6282132341102@s.whatsapp.net" }
const lidToJid = new Map();

function resolveLid(jid) {
  if (!jid.includes("@lid")) return jid;
  return lidToJid.get(jid) || jid;
}

function isAllowed(jid) {
  if (!jid) return false;

  // Check ALLOWED_LIDS (for @lid format JIDs)
  const allowedLidsRaw = process.env.ALLOWED_LIDS || "";
  const allowedLids = allowedLidsRaw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  // Extract the numeric/identifier part before the @ sign
  const idPart = jid.split("@")[0];

  if (allowedLids.some((lid) => lid === idPart)) {
    return true;
  }

  // Check ALLOWED_NUMBERS (for @s.whatsapp.net format JIDs)
  const allowedRaw = process.env.ALLOWED_NUMBERS || process.env.OWNER_NUMBER || "";
  const allowedNumbers = allowedRaw
    .split(",")
    .map((n) => n.trim().replace(/\D/g, ""))
    .filter(Boolean);

  const jidNumbers = jid.replace(/\D/g, "");

  return allowedNumbers.some(
    (number) => jidNumbers.includes(number) || number.includes(jidNumbers)
  );
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log("🔌 Menghubungkan ke WhatsApp...");
  console.log(`   Baileys version: ${version.join(".")}`);

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: ["ReminderBot", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 30_000,
  });

  sock.ev.on("creds.update", saveCreds);

  // ── Seed lid→JID map immediately from creds (available before any message) ──
  // state.creds.me contains { id: "628xxx@s.whatsapp.net", lid: "12345@lid" }
  // This handles the bot owner's own lid on first boot.
  if (state.creds?.me?.id && state.creds?.me?.lid) {
    lidToJid.set(state.creds.me.lid, state.creds.me.id);
    console.log(`📇 Seeded lid from creds: ${state.creds.me.lid} → ${state.creds.me.id}`);
  }

  // ── Build lid→JID map from contacts events (fires on sync, populates all contacts) ──
  sock.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts) {
      if (contact.id && contact.lid) {
        lidToJid.set(contact.lid, contact.id);
      }
    }
    console.log(`📇 Contacts upsert: ${lidToJid.size} total lid mappings`);
  });

  sock.ev.on("contacts.update", (updates) => {
    for (const update of updates) {
      if (update.id && update.lid) {
        lidToJid.set(update.lid, update.id);
      }
    }
  });

  // ── Also learn lids from incoming messages in real time ──────────────────
  // When a message arrives with @lid remoteJid, check messageContextInfo
  // which sometimes carries the real number. Also learn from group participant lists.
  sock.ev.on("groups.update", (updates) => {
    for (const update of updates) {
      if (!update.participants) continue;
      for (const p of update.participants) {
        if (p.id && p.lid) lidToJid.set(p.lid, p.id);
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.clear();
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("  📱 SCAN QR INI DENGAN NOMOR KEDUA KAMU");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
      qrcode.generate(qr, { small: true });
      console.log("\n  Buka WhatsApp → Linked Devices → Link a Device");
      console.log("  QR expired tiap ~20 detik, akan auto-refresh\n");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`\n🔴 Koneksi terputus. Status: ${statusCode}`);
      if (shouldReconnect) {
        reconnectCount++;
        const delay = Math.min(3000 * reconnectCount, 60_000);
        console.log(`🔄 Reconnect ke-${reconnectCount} dalam ${delay / 1000}s...`);
        setTimeout(connectToWhatsApp, delay);
      } else {
        console.log(`🚪 Logged out. Hapus folder ${AUTH_DIR} dan jalankan ulang.`);
        process.exit(0);
      }
    }

    if (connection === "open") {
      reconnectCount = 0;
      console.log("\n✅ WhatsApp berhasil terhubung!");
      console.log(`   Bot aktif sebagai: ${sock.user?.name || sock.user?.id}`);
      console.log("   Ketik !help untuk melihat perintah yang tersedia\n");

      if (!schedulerStarted) {
        startScheduler(sock);
        schedulerStarted = true;
      }

      if (!igMonitorStarted) {
        startInstagramMonitor(sock);
        igMonitorStarted = true;
      }

      if (!formMonitorStarted) {
        startFormMonitor(sock);
        formMonitorStarted = true;
      }

      if (isFirstConnect) {
        isFirstConnect = false;
        const ownerJid = `${process.env.OWNER_NUMBER}@s.whatsapp.net`;
        await sock
          .sendMessage(ownerJid, { text: `Hello, im here! Reo'sBot aktif🤖` })
          .catch(() => {});
      } else {
        console.log("   (Reconnect berhasil — startup message tidak dikirim ulang)");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.remoteJid === "status@broadcast") continue;
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const fromJid =
        msg.key.participantPn ||
        msg.key.senderPn ||
        msg.key.participant ||
        msg.key.remoteJid;

      // Resolve @lid to real phone JID using our contacts map
      const resolvedFromJid = resolveLid(fromJid);

      // ── Handle media (gambar/video) → sticker ──────────────────────────
      const mediaType = getMediaType(msg);
      if (mediaType) {
        if (!isAllowed(resolvedFromJid)) continue;

        const caption = getMediaCaption(msg);
        const captionCommand = caption.trim().toLowerCase();

        const isPrivate = !msg.key.remoteJid?.includes("@g.us");
        const wantsSticker =
          caption.toLowerCase().includes("!sticker") || isPrivate;

        if (captionCommand.startsWith("!") && !captionCommand.includes("!sticker")) {
          await handleCommand(sock, msg);
          continue;
        }

        if (!wantsSticker) continue;

        const mimeType = getMimeType(msg);
        const isVideo = mediaType === "video" || mimeType.startsWith("video/");
        console.log(`🎨 Membuat sticker dari ${isVideo ? "video" : "gambar"} (dari ${fromJid})`);

        // Always land on a final reaction state (✅ or ❌) so the UX is clear.
        let stickerSent = false;
        try {
          await sock.sendMessage(msg.key.remoteJid, {
            react: { text: "⏳", key: msg.key },
          }).catch(() => {});

          const buffer = await getMediaBuffer(sock, msg);
          if (!buffer) {
            await sock.sendMessage(
              msg.key.remoteJid,
              { text: "❌ Gagal download media." },
              { quoted: msg }
            ).catch(() => {});
            continue;
          }

          let stickerBuffer;
          if (isVideo) {
            stickerBuffer = await convertVideoToSticker(buffer, mimeType);
          } else {
            stickerBuffer = await convertImageToSticker(buffer);
          }

          await sock.sendMessage(msg.key.remoteJid, { sticker: stickerBuffer });
          stickerSent = true;

          console.log(`✅ Sticker ${isVideo ? "video" : "gambar"} berhasil dikirim`);
        } catch (err) {
          console.error(`❌ Error buat sticker:`, err.message);
          await sock
            .sendMessage(
              msg.key.remoteJid,
              { text: `❌ Gagal buat sticker: ${err.message}` },
              { quoted: msg }
            )
            .catch(() => {});
        } finally {
          // Always update the reaction to a definitive state so the photo
          // doesn't stay on ⏳ forever.
          await sock
            .sendMessage(msg.key.remoteJid, {
              react: { text: stickerSent ? "✅" : "❌", key: msg.key },
            })
            .catch(() => {});
        }

        continue;
      }

      // ── Handle teks → command handler ──────────────────────────────────
      // Inject resolved JID so commandHandler can use it for isAllowed check
      msg._resolvedFromJid = resolvedFromJid;
      await handleCommand(sock, msg);
    }
  });

  // ── Handle emoji reactions → auto-done if ✅ on a reminder message ────
  sock.ev.on("messages.reaction", async (reactions) => {
    for (const reaction of reactions) {
      try {
        await handleReaction(sock, reaction);
      } catch (err) {
        console.error("❌ Error handling reaction:", err.message);
      }
    }
  });

  return sock;
}

process.on("SIGINT", async () => {
  console.log("\n👋 Menutup bot...");
  process.exit(0);
});

connectToWhatsApp().catch(console.error);
