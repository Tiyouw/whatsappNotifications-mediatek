require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { startScheduler } = require("./src/scheduler");
const { handleCommand, handleReaction } = require("./src/commandHandler");
const {
  convertImageToSticker,
  convertVideoToSticker,
  getMediaBuffer,
  getMediaCaption,
  getMediaType,
  getMimeType,
} = require("./src/stickerHandler");

const logger = pino({ level: "silent" });

let sock = null;
let schedulerStarted = false;
let isFirstConnect = true;
let reconnectCount = 0;

function isAllowed(jid) {
  if (!jid) return false;
  const allowedRaw = process.env.ALLOWED_NUMBERS || process.env.OWNER_NUMBER || "";
  const allowedNumbers = allowedRaw
    .split(",")
    .map((n) => n.trim().replace(/\D/g, ""))
    .filter(Boolean);

  // Standard check — works for @s.whatsapp.net JIDs
  if (allowedNumbers.some((number) => jid.includes(number))) return true;

  // @lid fallback — newer WhatsApp sends @lid instead of @s.whatsapp.net
  // Try to resolve via sock contacts store
  if (jid.includes("@lid") && sock) {
    try {
      const contacts = sock.store?.contacts || sock.contacts || {}
      const contact = contacts[jid]
      const resolvedJid = contact?.lid || contact?.id || ""
      const resolvedNumber = resolvedJid.replace(/\D/g, "")
      if (resolvedNumber && allowedNumbers.some((n) => resolvedNumber.includes(n) || n.includes(resolvedNumber))) {
        return true
      }
      // Also check all contacts for a matching lid
      for (const [, c] of Object.entries(contacts)) {
        if (c?.lid === jid || c?.id === jid) {
          const num = (c.id || "").replace(/\D/g, "")
          if (allowedNumbers.some((n) => num.includes(n) || n.includes(num))) return true
        }
      }
    } catch {
      // ignore store lookup errors
    }
  }

  return false;
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
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
        console.log("🚪 Logged out. Hapus folder auth_info_baileys dan jalankan ulang.");
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

      // ── Handle media (gambar/video) → sticker ──────────────────────────
      const mediaType = getMediaType(msg);
      if (mediaType) {
        if (!isAllowed(fromJid)) continue;

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

        try {
          await sock.sendMessage(msg.key.remoteJid, {
            react: { text: "⏳", key: msg.key },
          });

          const buffer = await getMediaBuffer(sock, msg);
          if (!buffer) {
            await sock.sendMessage(
              msg.key.remoteJid,
              { text: "❌ Gagal download media." },
              { quoted: msg }
            );
            continue;
          }

          let stickerBuffer;
          if (isVideo) {
            stickerBuffer = await convertVideoToSticker(buffer, mimeType);
          } else {
            stickerBuffer = await convertImageToSticker(buffer);
          }

          await sock.sendMessage(msg.key.remoteJid, { sticker: stickerBuffer });
          await sock.sendMessage(msg.key.remoteJid, {
            react: { text: "✅", key: msg.key },
          });

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
        }

        continue;
      }

      // ── Handle teks → command handler ──────────────────────────────────
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
