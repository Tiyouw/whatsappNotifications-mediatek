const dayjs = require("dayjs");
const path = require("path");
const { readFile, writeFile, mkdir } = require("fs/promises");
const { getReminders, getDueReminders, markAsDone, addReminder, editReminder, deleteReminder } = require("./sheets");
const { formatSingleReminder, parseMentions, resolveTarget } = require("./reminder");
const { triggerManualCheck, sendWeeklySummary } = require("./scheduler");
const {
  convertImageToSticker,
  convertVideoToSticker,
  getMediaBuffer,
  getMediaType,
  getMimeType,
} = require("./stickerHandler");
const reactionMap = require("./reactionMap");
const { getIgStatus, setIgEnabled, checkInstagramNow, fetchLatestPostForSend, formatNotification, resolveNotifyTarget } = require("./instagramMonitor");
const { now } = require("./time");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const COMMAND_ALIASES = new Map([
  ["dam", "damn"],
  ["damm", "damn"],
  ["dammit", "damn"],
  ["setdam", "setdamn"],
  ["setdamm", "setdamn"],
  ["stiker", "sticker"],
]);

/**
 * Resolve DAMN_STICKER_PATH at call-time so changes to env are picked up
 * and so !setdamn writes to the same location !damn reads from.
 * Relative paths resolve against the project root.
 */
function resolveDamnStickerPath() {
  const raw = process.env.DAMN_STICKER_PATH || "./data/damn.webp";
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

/**
 * Reconstruct a Baileys-shaped msg object from the quotedMessage in a reply's
 * contextInfo. This lets sticker/media helpers operate on the quoted media
 * as if it were a regular incoming message.
 */
function buildQuotedMsg(msg) {
  const content = unwrapMessageContent(msg.message);
  const ctx = content?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return null;
  return {
    key: {
      remoteJid: msg.key.remoteJid,
      id: ctx.stanzaId,
      participant: ctx.participant,
      fromMe: false,
    },
    message: ctx.quotedMessage,
  };
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

/**
 * Resolve the real sender JID from a message, handling @lid fallback.
 * Newer WhatsApp uses @lid identifiers in groups instead of @s.whatsapp.net.
 * We try multiple fields to find one that contains a real phone number.
 */
function resolveSenderJid(msg) {
  const candidates = [
    msg.key.participantPn,
    msg.key.senderPn,
    // participantPn/senderPn usually contain the real number even when participant is @lid
    msg.key.participant,
    msg.key.remoteJid,
  ].filter(Boolean)

  // Prefer any JID that contains a recognisable phone number (not @lid)
  const real = candidates.find((j) => !j.includes("@lid"))
  if (real) return real

  // All candidates are @lid — return the first one anyway so caller can log it
  return candidates[0] || ""
}

function getMessageText(msg) {
  const content = unwrapMessageContent(msg.message);
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    ""
  ).trim();
}

function unwrapMessageContent(message) {
  let content = message;

  for (let i = 0; i < 8; i++) {
    const next =
      content?.ephemeralMessage?.message ||
      content?.viewOnceMessage?.message ||
      content?.viewOnceMessageV2?.message ||
      content?.documentWithCaptionMessage?.message ||
      content?.protocolMessage?.editedMessage;

    if (!next || next === content) break;
    content = next;
  }

  return content || {};
}

function isFromGroup(msg) {
  return msg.key.remoteJid?.includes("@g.us");
}

function parseNumberNameMap(raw) {
  const map = new Map();
  for (const part of (raw || "").split(",")) {
    const item = part.trim();
    if (!item) continue;
    const sep = item.includes("=") ? "=" : item.includes(":") ? ":" : null;
    if (!sep) continue;
    const [left, ...rest] = item.split(sep);
    const number = left.replace(/\D/g, "");
    const name = rest.join(sep).trim();
    if (!number || !name) continue;
    map.set(number, name);
  }
  return map;
}

function displayNameFromJid(jid) {
  const number = (jid || "").replace(/\D/g, "").replace(/^0/, "62");
  return parseNumberNameMap(process.env.NUMBER_NAME_MAP || "").get(number) || number || "unknown";
}

function filterByContext(reminders, msg, arg = "") {
  const fromGroup = isFromGroup(msg);
  const groupJid = msg.key.remoteJid;

  if (fromGroup) {
    return reminders.filter((r) => resolveTarget(r.target) === groupJid);
  }

  if (arg === "grup" || arg === "group") {
    return reminders.filter((r) => r.target?.includes("@g.us"));
  }

  if (arg === "saya" || arg === "aku" || arg === "me") {
    return reminders.filter((r) => resolveTarget(r.target)?.includes(process.env.OWNER_NUMBER || ""));
  }

  return reminders;
}

async function handleCommand(sock, msg) {
  const senderJid = msg.key.remoteJid;
  const text = getMessageText(msg);

  if (!text.startsWith("!")) return;

  // Use pre-resolved JID if injected by index.js (handles @lid)
  const fromJid = msg._resolvedFromJid || resolveSenderJid(msg);

  if (!isAllowed(fromJid)) {
    console.log(`⛔ Akses ditolak dari: ${fromJid}`);
    return;
  }

  const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/);
  const cmd = COMMAND_ALIASES.get(rawCmd.toLowerCase()) || rawCmd.toLowerCase();
  const argStr = args.join(" ").trim();

  console.log(`📥 Command: !${cmd} ${argStr} (dari ${fromJid})`);

  try {
    switch (cmd) {
      // ── !help ──────────────────────────────────────────────────────────
      case "help":
        await reply(
          sock,
          senderJid,
          msg,
          `🤖 *Reo'sBot — Command List*\n\n` +
            `📋 *REMINDER*\n` +
            `!cek — reminder aktif di konteks ini\n` +
            `!cek semua — semua reminder (dari pribadi)\n` +
            `!cek grup — semua reminder bertarget grup\n` +
            `!cek saya — reminder yang ditujukan ke kamu\n` +
            `!hari — reminder yang due hari ini\n` +
            `!kirim — kirim reminder hari ini sekarang\n` +
            `!tambah — tambah reminder baru\n` +
            `!edit [no] [field] [nilai] — ubah satu field\n` +
            `!done [no] — tandai reminder selesai\n` +
            `!hapus [no] — hapus reminder\n` +
            `!summary — ringkasan semua reminder aktif\n\n` +
            `✅ *REACTION SHORTCUT*\n` +
            `React ✅ pada pesan reminder pagi → otomatis\n` +
            `tandai reminder itu selesai (hanya nomor diizinkan)\n\n` +
            `🎨 *STICKER*\n` +
            `Pribadi: kirim gambar/video → langsung jadi sticker\n` +
            `Grup: kirim media + caption !sticker, atau\n` +
            `balas gambar/video dengan !sticker\n` +
            `Video max 10 detik\n\n` +
            `😤 *DAMN STICKER*\n` +
            `!damn — kirim sticker !damn\n` +
            `!setdamn — update sticker !damn:\n` +
            `   • balas gambar/video dengan !setdamn, atau\n` +
            `   • kirim gambar/video dengan caption !setdamn\n\n` +
            `ℹ️ *INFO*\n` +
            `!status — uptime & info bot\n` +
            `!help — pesan ini\n\n` +
            `📤 *SHARE*\n` +
            `!share <link> [caption] — share link ke grup\n\n` +
            `📝 *FORMAT !tambah*\n` +
            `!tambah task | YYYY-MM-DD | H-notif | catatan\n` +
            `Contoh: !tambah Rapat | 2026-05-10 | 3,1,0 | Di aula\n` +
            `Target otomatis: grup jika dari grup, pribadi jika DM\n\n` +
            `📝 *FORMAT !edit*\n` +
            `Field: task, deadline, notif, catatan\n` +
            `Contoh: !edit 3 deadline 2026-06-01\n\n` +
            `🔒 Reminder auto-import (tab Reminders) bisa\n` +
            `   ditandai selesai lewat !done atau react ✅ oleh nomor diizinkan`,
        );
        break;

      // ── !cek ──────────────────────────────────────────────────────────
      case "cek": {
        const allReminders = await getReminders();
        const filtered = filterByContext(allReminders, msg, argStr.toLowerCase());

        if (filtered.length === 0) {
          const hint = isFromGroup(msg) ? "Tidak ada reminder untuk grup ini." : "Tidak ada reminder aktif.";
          await reply(sock, senderJid, msg, `📋 ${hint}`);
          break;
        }

        const today = now().startOf("day");
        const allMentions = [];

        const lines = filtered.map((r) => {
          const daysLeft = r.deadline.startOf("day").diff(today, "day");
          const deadlineStr = r.deadline.format("DD MMM YYYY");
          const statusEmoji = daysLeft < 0 ? "🔴" : daysLeft === 0 ? "🔥" : daysLeft <= 3 ? "⚠️" : "📌";
          const daysText = daysLeft < 0 ? `(telat ${Math.abs(daysLeft)} hari)` : daysLeft === 0 ? "(Hari ini!)" : `(${daysLeft} hari lagi)`;

          const { text: notesText, mentions } = parseMentions(r.notes || "");
          allMentions.push(...mentions);

          const tag = r.source === "auto" ? " 🔒" : "";
          return `${statusEmoji} *[${r.globalNo}] ${r.task}*${tag}\n   📅 ${deadlineStr} ${daysText}${notesText ? `\n   📝 ${notesText}` : ""}`;
        });

        const contextLabel = isFromGroup(msg)
          ? "Grup Ini"
          : !argStr || argStr.toLowerCase() === "semua"
            ? "Semua"
            : `Filter: ${argStr}`;
        const fullText = `📋 *Reminder Aktif — ${contextLabel}*\n\n${lines.join("\n\n")}\n\n_🔒 = auto-import, bisa ditandai selesai lewat bot oleh nomor diizinkan_`;
        await reply(sock, senderJid, msg, fullText, [...new Set(allMentions)]);
        break;
      }

      // ── !hari ──────────────────────────────────────────────────────────
      case "hari": {
        const allDue = await getDueReminders();
        const filtered = filterByContext(allDue, msg);

        if (filtered.length === 0) {
          await reply(sock, senderJid, msg, "✅ Tidak ada reminder untuk dikirim hari ini.");
          break;
        }

        const allMentions = [];
        const lines = filtered.map((r) => {
          const { text: formattedText, mentions } = parseMentions(formatSingleReminder(r));
          allMentions.push(...mentions);
          return formattedText;
        });

        const fullText = `🔔 *Reminder Hari Ini (${filtered.length})*\n\n${lines.join("\n\n───\n\n")}`;
        await reply(sock, senderJid, msg, fullText, [...new Set(allMentions)]);
        break;
      }

      // ── !kirim ─────────────────────────────────────────────────────────
      case "kirim":
        await reply(sock, senderJid, msg, "🔄 Mengirim reminder hari ini...");
        await triggerManualCheck(sock);
        await reply(sock, senderJid, msg, "✅ Selesai!");
        break;

      // ── !damn ──────────────────────────────────────────────────────────
      case "damn":
        await sendDamnSticker(sock, senderJid, msg);
        break;

      // ── !setdamn ───────────────────────────────────────────────────────
      case "setdamn":
        await handleSetDamn(sock, senderJid, msg);
        break;

      // ── !sticker ───────────────────────────────────────────────────────
      case "sticker":
        await handleStickerCommand(sock, senderJid, msg);
        break;

      // ── !done ──────────────────────────────────────────────────────────
      case "done": {
        if (!argStr) {
          await reply(sock, senderJid, msg, "❓ Format: *!done [no]*\n\nContoh: !done 3\n\nGunakan !cek untuk lihat nomor.");
          break;
        }

        const targetNo = parseInt(argStr);
        if (isNaN(targetNo)) {
          await reply(sock, senderJid, msg, "❌ Nomor tidak valid. Contoh: !done 3");
          break;
        }

        const reminders = await getReminders();
        const found = reminders.find((r) => r.globalNo === targetNo);

        if (!found) {
          await reply(sock, senderJid, msg, `❌ Reminder no. ${targetNo} tidak ditemukan.`);
          break;
        }

        const who = displayNameFromJid(fromJid);
        const result = await markAsDone(found, who);
        if (result.success) {
          await reply(sock, senderJid, msg, `✅ *[${targetNo}] ${found.task}* ditandai selesai oleh ${who}! 🎉`);
        } else {
          await reply(sock, senderJid, msg, `❌ Gagal update: ${result.reason}`);
        }
        break;
      }

      // ── !tambah ────────────────────────────────────────────────────────
      case "tambah": {
        if (!argStr) {
          await reply(
            sock,
            senderJid,
            msg,
            `📝 *Format tambah reminder:*\n\n` +
              `!tambah [task] | [deadline] | [H-notif] | [catatan]\n\n` +
              `*Contoh:*\n` +
              `!tambah Laporan Bulanan | 2026-05-31 | 7,3,1,0 | Kirim ke email\n\n` +
              `📌 Target otomatis:\n` +
              `• Dari grup → reminder ke grup ini\n` +
              `• Dari pribadi → reminder ke kamu\n\n` +
              `📌 Disimpan di tab *MyReminders*`,
          );
          break;
        }

        const parts = argStr.split("|").map((p) => p.trim());
        if (parts.length < 2) {
          await reply(sock, senderJid, msg, "❌ Format salah. Ketik !tambah untuk panduan.");
          break;
        }

        const [task, deadline, notifyDays = "7,3,1,0", notes = ""] = parts;

        if (!dayjs(deadline).isValid()) {
          await reply(sock, senderJid, msg, "❌ Format deadline salah. Gunakan YYYY-MM-DD");
          break;
        }

        // Pick the right target for the new reminder:
        // - From a group → send to this group
        // - From private chat with a phone JID → send to that number
        // - From private chat with @lid → route to the owner (we can't reliably
        //   resolve an @lid back to a phone number without a contact sync)
        const isLidSender = fromJid?.includes("@lid");
        const autoTarget = isFromGroup(msg)
          ? senderJid
          : fromJid?.includes("@s.whatsapp.net")
            ? fromJid
            : `${process.env.OWNER_NUMBER}@s.whatsapp.net`;

        const success = await addReminder({ task, deadline, target: autoTarget, notifyDays, notes });
        if (success) {
          const targetLabel = isFromGroup(msg)
            ? "grup ini"
            : isLidSender
              ? `nomor owner (${process.env.OWNER_NUMBER}) — kirim dari grup jika mau ke nomor lain`
              : "kamu";
          await reply(
            sock,
            senderJid,
            msg,
            `✅ Reminder ditambahkan ke *MyReminders*!\n\n` + `📌 *${task}*\n` + `📅 Deadline: ${dayjs(deadline).format("DD MMM YYYY")}\n` + `🔔 Notif di H-: ${notifyDays}\n` + `📨 Target: ${targetLabel}`,
          );
        } else {
          await reply(sock, senderJid, msg, "❌ Gagal menambah reminder.");
        }
        break;
      }

      // ── !edit ──────────────────────────────────────────────────────────
      case "edit": {
        const editParts = argStr.match(/^(\d+)\s+(\w+)\s+(.+)$/);
        if (!editParts) {
          await reply(
            sock,
            senderJid,
            msg,
            `❓ *Format !edit:*\n\n` +
              `!edit [no] [field] [nilai baru]\n\n` +
              `*Field:* task, deadline, notif, catatan\n\n` +
              `*Contoh:*\n` +
              `!edit 2 task Laporan Akhir\n` +
              `!edit 2 deadline 2026-06-01\n` +
              `!edit 2 notif 7,3,1,0\n` +
              `!edit 2 catatan Kirim via email`,
          );
          break;
        }

        const [, editNoStr, editField, editValue] = editParts;
        const editNo = parseInt(editNoStr);
        const reminders = await getReminders();
        const found = reminders.find((r) => r.globalNo === editNo);

        if (!found) {
          await reply(sock, senderJid, msg, `❌ Reminder no. ${editNo} tidak ditemukan.`);
          break;
        }

        const validFields = ["task", "nama", "deadline", "tanggal", "notif", "catatan", "notes"];
        if (!validFields.includes(editField.toLowerCase())) {
          await reply(sock, senderJid, msg, `❌ Field *${editField}* tidak valid.\nPilih: task, deadline, notif, catatan`);
          break;
        }

        const result = await editReminder(found, editField, editValue);
        if (result.success) {
          await reply(sock, senderJid, msg, `✅ *[${editNo}] ${found.task}* diupdate!\n📝 ${editField}: *${editValue}*`);
        } else {
          await reply(sock, senderJid, msg, `❌ Gagal update: ${result.reason}`);
        }
        break;
      }

      // ── !hapus ─────────────────────────────────────────────────────────
      case "hapus": {
        if (!argStr) {
          await reply(sock, senderJid, msg, "❓ Format: *!hapus [no]*\n\nContoh: !hapus 3");
          break;
        }

        const hapusNo = parseInt(argStr);
        if (isNaN(hapusNo)) {
          await reply(sock, senderJid, msg, "❌ Nomor tidak valid.");
          break;
        }

        const reminders = await getReminders();
        const found = reminders.find((r) => r.globalNo === hapusNo);

        if (!found) {
          await reply(sock, senderJid, msg, `❌ Reminder no. ${hapusNo} tidak ditemukan.`);
          break;
        }

        const result = await deleteReminder(found);
        if (result.success) {
          await reply(sock, senderJid, msg, `🗑️ *[${hapusNo}] ${found.task}* berhasil dihapus.`);
        } else {
          await reply(sock, senderJid, msg, `❌ Gagal hapus: ${result.reason}`);
        }
        break;
      }

      // ── !summary ───────────────────────────────────────────────────────
      case "summary":
        await reply(sock, senderJid, msg, "📋 Mengirim weekly summary...");
        await sendWeeklySummary(sock, senderJid);
        break;

      // ── !ig ──────────────────────────────────────────────────────────
      case "ig": {
        const subCmd = args[0]?.toLowerCase() || "";

        switch (subCmd) {
          case "status": {
            const status = getIgStatus();
            const enabledText = status.enabled ? "Aktif \uD83D\uDFE2" : "Nonaktif \uD83D\uDD34";
            const lastNotif = status.lastNotificationSent
              ? new Date(status.lastNotificationSent).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
              : "Belum pernah";
            const lastCheck = status.lastChecked
              ? new Date(status.lastChecked).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
              : "Belum pernah";
            const lastUrl = status.lastPostUrl || "-";
            const errText = status.consecutiveErrors > 0
              ? `\n\u26A0\uFE0F Consecutive errors: ${status.consecutiveErrors}`
              : "";

            // Graph API method info
            const methodText = status.graphApiConfigured
              ? "Graph API \u2705"
              : "Scraping (fallback)";
            const tokenExpiry = status.tokenExpiresAt
              ? `\nToken expires: ${status.tokenExpiresAt}`
              : "";
            const lastMethodText = status.lastMethod
              ? `\nLast successful method: ${status.lastMethod}`
              : "";

            await reply(
              sock,
              senderJid,
              msg,
              `\uD83D\uDCF8 *Instagram Monitor Status*\n\n` +
                `Status: ${enabledText}\n` +
                `Method: ${methodText}\n` +
                `Mode: ${status.mode}\n` +
                `Username: @${status.username}\n` +
                `Cron: ${status.cronExpression}\n` +
                `Target: ${status.notifyTarget}${tokenExpiry}${lastMethodText}\n` +
                `Last check: ${lastCheck}\n` +
                `Last notification: ${lastNotif}\n` +
                `Last post URL: ${lastUrl}${errText}`
            );
            break;
          }

          case "check": {
            await reply(sock, senderJid, msg, `\uD83D\uDD04 Checking Instagram now...`);
            const result = await checkInstagramNow(sock);
            if (result.success) {
              await reply(sock, senderJid, msg, `\u2705 ${result.message}`);
            } else {
              await reply(sock, senderJid, msg, `\u274C Check failed: ${result.reason}`);
            }
            break;
          }

          case "on": {
            const ownerNum = process.env.OWNER_NUMBER || "";
            if (!ownerNum || !fromJid.includes(ownerNum)) {
              await reply(sock, senderJid, msg, `\u26D4 Hanya owner yang bisa mengubah status monitor.`);
              break;
            }
            setIgEnabled(true);
            await reply(sock, senderJid, msg, `\u2705 Instagram monitor diaktifkan.`);
            break;
          }

          case "off": {
            const ownerNum = process.env.OWNER_NUMBER || "";
            if (!ownerNum || !fromJid.includes(ownerNum)) {
              await reply(sock, senderJid, msg, `\u26D4 Hanya owner yang bisa mengubah status monitor.`);
              break;
            }
            setIgEnabled(false);
            await reply(sock, senderJid, msg, `\u2705 Instagram monitor dinonaktifkan.`);
            break;
          }

          case "send": {
            const ownerNum = process.env.OWNER_NUMBER || "";
            if (!ownerNum || !fromJid.includes(ownerNum)) {
              await reply(sock, senderJid, msg, `\u26D4 Hanya owner yang bisa menggunakan !ig send.`);
              break;
            }

            const sendN = parseInt(args[1]) || 1;
            if (sendN < 1 || sendN > 25) {
              await reply(sock, senderJid, msg, `\u274C Nomor harus antara 1-25. Contoh: !ig send 3`);
              break;
            }

            await reply(sock, senderJid, msg, `\uD83D\uDD04 Mengambil post #${sendN}...`);

            try {
              const post = await fetchLatestPostForSend(sendN);
              if (!post) {
                await reply(sock, senderJid, msg, `\u274C Gagal mengambil post dari Instagram.`);
                break;
              }

              const targetJid = resolveNotifyTarget();
              const text = formatNotification(post);
              await sock.sendMessage(targetJid, { text });

              const targetLabel = process.env.IG_NOTIFY_TARGET || "owner";
              await reply(sock, senderJid, msg, `\u2705 Post terbaru sudah dikirim ke ${targetLabel}`);
            } catch (err) {
              await reply(sock, senderJid, msg, `\u274C Gagal kirim post: ${err.message}`);
            }
            break;
          }

          default:
            await reply(
              sock,
              senderJid,
              msg,
              `\uD83D\uDCF8 *Instagram Monitor Commands*\n\n` +
                `!ig status \u2014 cek status monitoring\n` +
                `!ig check \u2014 manual check sekarang\n` +
                `!ig send \u2014 kirim post terbaru ke target\n` +
                `!ig send [n] \u2014 kirim post ke-n (1-25)\n` +
                `!ig on \u2014 aktifkan monitoring\n` +
                `!ig off \u2014 nonaktifkan monitoring\n\n` +
                `Mode: ${process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN ? "Graph API (primary) + scraping (fallback)" : "Scraping"} setiap ${process.env.IG_CHECK_CRON || "*/5 * * * *"}`
            );
        }
        break;
      }

      // ── !share ────────────────────────────────────────────────────────
      case "share": {
        // Extract URL from the message (everything after !share)
        const shareFullText = text.slice(1 + cmd.length).trim(); // text after "!share"
        const urlRegex = /https?:\/\/[^\s]+/i;
        const urlMatch = shareFullText.match(urlRegex);

        if (!urlMatch) {
          await reply(
            sock,
            senderJid,
            msg,
            `❓ Format: *!share <link> [caption]*\n\nContoh:\n!share https://instagram.com/p/ABC123\n!share https://tiktok.com/@user/video/123 Cek video baru!`
          );
          break;
        }

        const shareUrl = urlMatch[0];
        // Caption is everything except the command word and the URL
        const shareCaption = shareFullText.replace(urlRegex, "").trim();

        // Determine emoji and title based on URL
        let shareEmoji = "\uD83D\uDCE2"; // 📢
        let shareTitle = "Post baru!";
        if (shareUrl.toLowerCase().includes("instagram.com")) {
          shareEmoji = "\uD83D\uDCF8"; // 📸
          shareTitle = "Post baru di Instagram!";
        } else if (shareUrl.toLowerCase().includes("tiktok.com")) {
          shareEmoji = "\uD83C\uDFB5"; // 🎵
          shareTitle = "Video baru di TikTok!";
        }

        // Build notification message
        let shareNotification = `${shareEmoji} ${shareTitle}\n`;
        if (shareCaption) {
          shareNotification += `\n"${shareCaption}"\n`;
        }
        shareNotification += `\n\uD83D\uDD17 ${shareUrl}\n`;
        shareNotification += `\nJangan lupa like ya! \u2764\uFE0F`;

        // Resolve target JID (reuse IG_NOTIFY_TARGET logic)
        const shareTargetRaw = process.env.IG_NOTIFY_TARGET || "owner";
        const shareTargetJid = shareTargetRaw === "owner"
          ? `${process.env.OWNER_NUMBER}@s.whatsapp.net`
          : shareTargetRaw;

        // Send notification to target
        await sock.sendMessage(shareTargetJid, { text: shareNotification });

        // Confirm to sender
        await reply(sock, senderJid, msg, "\u2705 Shared! Notifikasi sudah dikirim.");
        break;
      }

      // ── !status ────────────────────────────────────────────────────────
      case "status": {
        const reminders = await getReminders();
        const cronExpr = process.env.REMINDER_CRON || "0 8 * * *";
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);

        await reply(
          sock,
          senderJid,
          msg,
          `📊 *Status Bot*\n\n` + `🟢 Status: Online\n` + `⏱️ Uptime: ${hours}j ${minutes}m\n` + `📋 Reminder aktif: ${reminders.length}\n` + `⏰ Scheduler: ${cronExpr}\n` + `📅 Waktu sekarang: ${now().format("DD/MM/YYYY HH:mm")} WIB`,
        );
        break;
      }

      default:
        await reply(sock, senderJid, msg, `❓ Perintah *!${cmd}* tidak dikenal.\nKetik *!help* untuk daftar perintah.`);
    }
  } catch (err) {
    console.error(`❌ Error handling command !${cmd}:`, err.message);
    await reply(sock, senderJid, msg, `❌ Terjadi error: ${err.message}`);
  }
}

async function reply(sock, jid, msg, text, mentions = []) {
  await sock.sendMessage(jid, { text, mentions }, { quoted: msg });
}

async function sendDamnSticker(sock, jid, msg) {
  const stickerPath = resolveDamnStickerPath();
  try {
    const sticker = await readFile(stickerPath);
    await sock.sendMessage(jid, { sticker }, { quoted: msg });
  } catch (err) {
    console.error("❌ Gagal kirim !damn sticker:", err.message);
    await reply(sock, jid, msg, "❌ Sticker !damn belum tersedia di server.");
  }
}

/**
 * Convert media into a sticker from either:
 *   - media attached directly to the invoking message, or
 *   - media quoted by a reply that says !sticker.
 */
async function handleStickerCommand(sock, jid, msg) {
  let sourceMsg = getMediaType(msg) ? msg : null;

  if (!sourceMsg) {
    const quoted = buildQuotedMsg(msg);
    if (quoted && getMediaType(quoted)) {
      sourceMsg = quoted;
    }
  }

  if (!sourceMsg) {
    await reply(
      sock,
      jid,
      msg,
      `🎨 *!sticker* — cara pakai:\n\n` +
        `• Balas gambar/video dengan !sticker\n` +
        `• Kirim gambar/video dengan caption !sticker\n` +
        `• Di chat pribadi, kirim gambar/video langsung\n\n` +
        `Video max 10 detik`,
    );
    return;
  }

  await sock.sendMessage(jid, { react: { text: "⏳", key: msg.key } }).catch(() => {});

  let success = false;
  try {
    const buffer = await getMediaBuffer(sock, sourceMsg);
    if (!buffer) {
      await reply(sock, jid, msg, "❌ Gagal download media.");
      return;
    }

    const mimeType = getMimeType(sourceMsg);
    const mediaType = getMediaType(sourceMsg);
    const isVideo = mediaType === "video" || mimeType.startsWith("video/");

    const stickerBuffer = isVideo
      ? await convertVideoToSticker(buffer, mimeType)
      : await convertImageToSticker(buffer);

    await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: msg });
    success = true;
    console.log(`✅ Sticker ${isVideo ? "video" : "gambar"} berhasil dikirim via !sticker reply`);
  } catch (err) {
    console.error("❌ Gagal buat sticker via !sticker:", err.message);
    await reply(sock, jid, msg, `❌ Gagal buat sticker: ${err.message}`);
  } finally {
    await sock
      .sendMessage(jid, { react: { text: success ? "✅" : "❌", key: msg.key } })
      .catch(() => {});
  }
}

/**
 * Update the !damn sticker. Accepts media either directly on the invoking
 * message (caption !setdamn) or on a message being quoted (reply with !setdamn).
 */
async function handleSetDamn(sock, jid, msg) {
  // Flow B: media attached directly to this message
  let sourceMsg = getMediaType(msg) ? msg : null;

  // Flow A: replying to a message that has media
  if (!sourceMsg) {
    const quoted = buildQuotedMsg(msg);
    if (quoted && getMediaType(quoted)) {
      sourceMsg = quoted;
    }
  }

  if (!sourceMsg) {
    await reply(
      sock,
      jid,
      msg,
      "❓ *!setdamn* — balas pesan gambar/video dengan !setdamn, atau kirim gambar/video dengan caption !setdamn",
    );
    return;
  }

  await sock.sendMessage(jid, { react: { text: "⏳", key: msg.key } }).catch(() => {});

  let success = false;
  try {
    const buffer = await getMediaBuffer(sock, sourceMsg);
    if (!buffer) {
      await reply(sock, jid, msg, "❌ Gagal download media.");
      return;
    }

    const mimeType = getMimeType(sourceMsg);
    const mediaType = getMediaType(sourceMsg);
    const isVideo = mediaType === "video" || mimeType.startsWith("video/");

    const stickerBuffer = isVideo
      ? await convertVideoToSticker(buffer, mimeType)
      : await convertImageToSticker(buffer);

    const stickerPath = resolveDamnStickerPath();
    await mkdir(path.dirname(stickerPath), { recursive: true });
    await writeFile(stickerPath, stickerBuffer);

    success = true;
    await reply(sock, jid, msg, "✅ Sticker !damn berhasil diupdate!");
    console.log(`✅ !damn sticker updated → ${stickerPath}`);
  } catch (err) {
    console.error("❌ Gagal update !damn sticker:", err.message);
    await reply(sock, jid, msg, `❌ Gagal update sticker !damn: ${err.message}`);
  } finally {
    // Always land on a definitive reaction state so the photo isn't stuck on ⏳
    await sock
      .sendMessage(jid, { react: { text: success ? "✅" : "❌", key: msg.key } })
      .catch(() => {});
  }
}

/**
 * Handle emoji reactions on messages.
 *
 * Flow:
 *   1. Reaction event fires from index.js
 *   2. Extract the reacted-to messageId and the reactor's JID
 *   3. Only process ✅ reactions from allowed numbers
 *   4. Look up messageId in reactionMap → get reminderNo
 *   5. Mark that reminder as done in Google Sheets
 *   6. Send a confirmation message back to the chat
 *
 * Baileys reaction event shape:
 * {
 *   key: { remoteJid, id, participant? },   ← the REACTION message itself
 *   reaction: {
 *     key: { remoteJid, id, participant? }, ← the ORIGINAL message being reacted to
 *     text: "✅"                            ← the emoji
 *   }
 * }
 */
async function handleReaction(sock, reaction) {
  // The emoji that was reacted
  const emoji = reaction.reaction?.text || "";

  // Only care about ✅
  if (emoji !== "✅") return;

  // Who reacted — for groups, the reactor is in reaction.reaction.groupParticipant
  // or reaction.participant. reaction.key is about the MESSAGE context, not the reactor.
  const reactorJid = [
    reaction.reaction?.groupParticipant,
    reaction.participant,
    reaction.key?.participant,
  ].filter(Boolean).find((j) => !j.includes("@lid"))
    || reaction.reaction?.groupParticipant
    || reaction.participant
    || reaction.key?.participant
    || "";

  // The chat where the reaction happened
  const chatJid = reaction.key?.remoteJid || "";

  console.log(`📋 Reaction event: emoji=${emoji}, reactor=${reactorJid}, chat=${chatJid}, fields=[groupParticipant=${reaction.reaction?.groupParticipant || 'N/A'}, participant=${reaction.participant || 'N/A'}, key.participant=${reaction.key?.participant || 'N/A'}]`);

  // Access control — same whitelist as commands
  if (!isAllowed(reactorJid)) {
    console.log(`⛔ Reaction ✅ dari non-allowed: ${reactorJid}`);
    return;
  }

  // The messageId of the ORIGINAL reminder message that was reacted to
  const originalMsgId = reaction.reaction?.key?.id;
  if (!originalMsgId) return;

  // Look up which reminder this message belongs to
  const entry = reactionMap.get(originalMsgId);
  console.log(`📋 Reaction ✅ received: msgId=${originalMsgId?.substring(0, 20)}..., mapped=${!!entry}`);
  if (!entry) {
    // Not a tracked reminder message — silently ignore
    return;
  }

  const { reminderNo } = entry;
  console.log(`✅ Reaction dari ${reactorJid} → reminder [${reminderNo}]`);

  // Fetch reminders and find the one matching reminderNo
  const reminders = await getReminders();
  const found = reminders.find((r) => r.globalNo === reminderNo);

  if (!found) {
    console.warn(`⚠️  Reminder [${reminderNo}] tidak ditemukan saat reaction`);
    return;
  }

  const who = displayNameFromJid(reactorJid);
  const result = await markAsDone(found, who);

  if (result.success) {
    // Remove from map so double-reacts don't re-trigger
    reactionMap.remove(originalMsgId);

    // Confirm in the same chat
    await sock.sendMessage(chatJid, {
      text: `✅ *[${reminderNo}] ${found.task}* ditandai selesai oleh ${who}! 🎉`,
    });

    console.log(`   ✅ Reminder [${reminderNo}] marked done via reaction by ${who}`);
  } else {
    console.error(`   ❌ Gagal mark done via reaction: ${result.reason}`);
  }
}

module.exports = { handleCommand, handleReaction, getMessageText, unwrapMessageContent };
