require("dotenv").config();

// When running as a Windows service, stdout/stderr go to log files.
// Some upstream libs can accidentally print session material; redact it.
const _consoleLog = console.log.bind(console);
const _consoleError = console.error.bind(console);
function redactConsoleArgs(args) {
  try {
    const text = args
      .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || a.message : ""))
      .join(" ");
    if (
      text.includes("Closing session: SessionEntry") ||
      text.includes("privKey:") ||
      text.includes("rootKey:") ||
      text.includes("ephemeralKeyPair:")
    ) {
      return ["[redacted session log]"];
    }
  } catch {}
  return args;
}
console.log = (...args) => _consoleLog(...redactConsoleArgs(args));
console.error = (...args) => _consoleError(...redactConsoleArgs(args));
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
const { handleCommand } = require("./src/commandHandler");
const { convertToSticker, getImageBuffer } = require("./src/stickerHandler");

const logger = pino({ level: "silent" });

let sock = null;
let schedulerStarted = false;  // ← cegah scheduler dobel
let isFirstConnect = true;     // ← cegah startup message dobel
let reconnectCount = 0;

function isAllowed(jid) {
  if (!jid) return false;
  const allowedRaw = process.env.ALLOWED_NUMBERS || process.env.OWNER_NUMBER || "";
  const allowedNumbers = allowedRaw
    .split(",")
    .map((n) => n.trim().replace(/\D/g, ""))
    .filter(Boolean);
  return allowedNumbers.some((number) => jid.includes(number));
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
    keepAliveIntervalMs: 30_000,  // ← ping WA tiap 30 detik agar koneksi tetap hidup
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
        // Exponential backoff: makin sering disconnect, makin lama tunggu
        // max 60 detik
        const delay = Math.min(3000 * reconnectCount, 60_000);
        console.log(`🔄 Reconnect ke-${reconnectCount} dalam ${delay / 1000}s...`);
        setTimeout(connectToWhatsApp, delay);
      } else {
        console.log("🚪 Logged out. Hapus folder auth_info_baileys dan jalankan ulang.");
        process.exit(0);
      }
    }

    if (connection === "open") {
      reconnectCount = 0; // reset counter setelah berhasil konek
      console.log("\n✅ WhatsApp berhasil terhubung!");
      console.log(`   Bot aktif sebagai: ${sock.user?.name || sock.user?.id}`);
      console.log("   Ketik !help untuk melihat perintah yang tersedia\n");

      // Scheduler hanya distart sekali meskipun reconnect berkali-kali
      if (!schedulerStarted) {
        startScheduler(sock);
        schedulerStarted = true;
      }

      // Startup message hanya dikirim sekali saat pertama kali connect
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

      // ── Handle pesan gambar → sticker ──────────────────────────────────
      if (msg.message?.imageMessage) {
        if (!isAllowed(fromJid)) continue;

        const caption = msg.message.imageMessage.caption?.trim() || "";
        const isPrivate = !msg.key.remoteJid?.includes("@g.us");
        const wantsSticker = caption.toLowerCase().includes("!sticker") || isPrivate;

        if (!wantsSticker) continue;

        console.log(`🎨 Membuat sticker (dari ${fromJid})`);

        try {
          await sock.sendMessage(msg.key.remoteJid, {
            react: { text: "⏳", key: msg.key },
          });

          const imageBuffer = await getImageBuffer(sock, msg);
          if (!imageBuffer) {
            await sock.sendMessage(
              msg.key.remoteJid,
              { text: "❌ Gagal download gambar." },
              { quoted: msg }
            );
            continue;
          }

          const stickerBuffer = await convertToSticker(imageBuffer);
          await sock.sendMessage(msg.key.remoteJid, { sticker: stickerBuffer });
          await sock.sendMessage(msg.key.remoteJid, {
            react: { text: "✅", key: msg.key },
          });

          console.log("✅ Sticker berhasil dikirim");
        } catch (err) {
          console.error("❌ Error buat sticker:", err.message);
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

      // ── Handle pesan teks → command handler ────────────────────────────
      await handleCommand(sock, msg);
    }
  });

  return sock;
}

process.on("SIGINT", async () => {
  console.log("\n👋 Menutup bot...");
  process.exit(0);
});

connectToWhatsApp().catch(console.error);
