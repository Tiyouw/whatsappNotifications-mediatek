const dayjs = require("dayjs");
const path = require("path");
const { readFile } = require("fs/promises");
const { getReminders, getDueReminders, markAsDone, addReminder, editReminder, deleteReminder } = require("./sheets");
const { formatSingleReminder, parseMentions, resolveTarget } = require("./reminder");
const { triggerManualCheck, sendWeeklySummary } = require("./scheduler");
const reactionMap = require("./reactionMap");
const { now } = require("./time");

const DAMN_STICKER_PATH = path.resolve(__dirname, "..", "data", "damn.webp");
const COMMAND_ALIASES = new Map([
  ["dam", "damn"],
  ["damm", "damn"],
  ["dammit", "damn"],
]);

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
            `!hari — reminder yang due hari ini\n` +
            `!kirim — trigger kirim reminder sekarang\n` +
            `!done [no] — tandai reminder selesai\n` +
            `!tambah — tambah reminder baru\n` +
            `!edit [no] [field] [nilai] — ubah satu field\n` +
            `!hapus [no] — hapus reminder\n` +
            `!summary — ringkasan semua reminder aktif\n` +
            `!damn — kirim sticker damn\n\n` +
            `✅ *REACTION SHORTCUT*\n` +
            `React ✅ pada pesan reminder pagi\n` +
            `→ otomatis tandai reminder itu selesai\n` +
            `(hanya berlaku untuk nomor yang diizinkan)\n\n` +
            `📝 *FORMAT !tambah*\n` +
            `!tambah task | YYYY-MM-DD | H-notif | catatan\n` +
            `Contoh: !tambah Rapat | 2026-05-10 | 3,1,0 | Di aula\n` +
            `Target: otomatis grup/pribadi sesuai konteks\n\n` +
            `📝 *FORMAT !edit*\n` +
            `Field: task, deadline, notif, catatan\n` +
            `Contoh: !edit 3 deadline 2026-06-01\n\n` +
            `🎨 *STICKER*\n` +
            `Pribadi: kirim gambar/video → langsung jadi sticker\n` +
            `Grup: kirim media + caption !sticker\n` +
            `Video max 10 detik\n\n` +
            `ℹ️ *INFO*\n` +
            `!status — uptime & info bot\n` +
            `!help — pesan ini\n\n` +
            `🔒 Reminder auto-import (tab Reminders) tidak bisa\n` +
            `   di-!done/!edit/!hapus — ubah langsung di Sheet`,
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

        const contextLabel = isFromGroup(msg) ? "Grup Ini" : argStr ? `Filter: ${argStr}` : "Semua";
        const fullText = `📋 *Reminder Aktif — ${contextLabel}*\n\n${lines.join("\n\n")}\n\n_🔒 = auto-import, ubah status langsung di Sheet_`;
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

        const autoTarget = isFromGroup(msg) ? senderJid : fromJid?.includes("@s.whatsapp.net") ? fromJid : `${process.env.OWNER_NUMBER}@s.whatsapp.net`;

        const success = await addReminder({ task, deadline, target: autoTarget, notifyDays, notes });
        if (success) {
          await reply(
            sock,
            senderJid,
            msg,
            `✅ Reminder ditambahkan ke *MyReminders*!\n\n` + `📌 *${task}*\n` + `📅 Deadline: ${dayjs(deadline).format("DD MMM YYYY")}\n` + `🔔 Notif di H-: ${notifyDays}\n` + `📨 Target: ${isFromGroup(msg) ? "grup ini" : "kamu"}`,
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
  try {
    const sticker = await readFile(DAMN_STICKER_PATH);
    await sock.sendMessage(jid, { sticker }, { quoted: msg });
  } catch (err) {
    console.error("❌ Gagal kirim !damn sticker:", err.message);
    await reply(sock, jid, msg, "❌ Sticker !damn belum tersedia di server.");
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

  // Who reacted — prefer participant (group), fall back to remoteJid (DM)
  // Also handle @lid by preferring non-lid candidates
  const reactorJid = [
    reaction.key?.participantPn,
    reaction.key?.senderPn,
    reaction.key?.participant,
    reaction.key?.remoteJid,
  ].filter(Boolean).find((j) => !j.includes("@lid"))
    || reaction.key?.participant
    || reaction.key?.remoteJid
    || "";

  // The chat where the reaction happened
  const chatJid = reaction.key?.remoteJid || "";

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
