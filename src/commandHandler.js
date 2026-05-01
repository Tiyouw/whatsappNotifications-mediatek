const dayjs = require("dayjs");
const { getReminders, getDueReminders, markAsDone, addReminder, editReminder, deleteReminder } = require("./sheets");
const { formatSingleReminder, parseMentions, resolveTarget } = require("./reminder");
const { triggerManualCheck, sendWeeklySummary } = require("./scheduler");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { convertImageToSticker, getMediaBuffer } = require("./stickerHandler");

const pendingDoneApprovals = new Map();
const DONE_APPROVAL_TTL_MS = parseInt(process.env.DONE_APPROVAL_TTL_MS || "900000"); // 15 minutes

function normalizeDigits(value) {
  return (value || "").toString().replace(/\D/g, "");
}

function getNumberFromJid(jid) {
  return normalizeDigits(jid).replace(/^0/, "62");
}

function parseNameMap(raw) {
  // Format: 628xxx=Name,628yyy=Name2
  // Also supports ":" as separator: 628xxx:Name
  const map = new Map();
  for (const part of (raw || "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const sep = p.includes("=") ? "=" : p.includes(":") ? ":" : null;
    if (!sep) continue;
    const [left, ...rest] = p.split(sep);
    const number = normalizeDigits(left);
    const name = rest.join(sep).trim();
    if (!number || !name) continue;
    map.set(number, name);
  }
  return map;
}

function nameMap() {
  return parseNameMap(process.env.NUMBER_NAME_MAP || "");
}

function displayNameFromJid(jid) {
  const number = getNumberFromJid(jid);
  const map = nameMap();
  return map.get(number) || number || "unknown";
}

function parseNumberList(raw) {
  return (raw || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => (n === "OWNER_NUMBER" ? process.env.OWNER_NUMBER || "" : n))
    .map((n) => n.replace(/\D/g, ""))
    .filter(Boolean);
}

function isAllowed(jid) {
  if (!jid) return false;
  const allowedRaw = process.env.ALLOWED_NUMBERS || process.env.OWNER_NUMBER || "";
  const allowedNumbers = parseNumberList(allowedRaw);
  return allowedNumbers.some((number) => jid.includes(number));
}

function isOwner(jid) {
  const ownerNumber = process.env.OWNER_NUMBER || "";
  return jid?.includes(ownerNumber);
}

function approverLabel() {
  return (process.env.APPROVER_LABEL || "Abang").toString().trim() || "Abang";
}

function getApproverNumbers() {
  // Default: OWNER_NUMBER only
  const raw = (process.env.APPROVER_NUMBERS || "").toString().trim();
  const list = raw ? parseNumberList(raw) : parseNumberList(process.env.OWNER_NUMBER || "");
  return [...new Set(list)];
}

function isApprover(jid) {
  if (!jid) return false;
  const approvers = getApproverNumbers();
  // Backward compatible: if env misconfigured, OWNER is still the last gate.
  if (approvers.length === 0) return isOwner(jid);
  return approvers.some((number) => jid.includes(number));
}

function getApproverJids() {
  const approvers = getApproverNumbers();
  if (approvers.length === 0 && process.env.OWNER_NUMBER) return [`${process.env.OWNER_NUMBER}@s.whatsapp.net`];
  return approvers.map((n) => `${n}@s.whatsapp.net`);
}

function requireOwnerApproval() {
  const raw = (process.env.DONE_REQUIRE_OWNER_APPROVAL || "").toString().trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function newApprovalCode() {
  return crypto.randomBytes(3).toString("hex"); // 6 chars
}

function resolveDamnStickerPath() {
  const raw = (process.env.DAMN_STICKER_PATH || "./data/damn.webp").toString().trim();
  return path.resolve(raw);
}

function buildQuotedMessageForDownload(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quotedMessage = ctx?.quotedMessage;
  if (!quotedMessage) return null;

  const key = {
    remoteJid: msg.key.remoteJid,
    fromMe: false,
    id: ctx.stanzaId || msg.key.id,
    participant: ctx.participant || msg.key.participant,
  };

  return { key, message: quotedMessage };
}

function getMessageText(msg) {
  return (msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "").trim();
}

function isFromGroup(msg) {
  return msg.key.remoteJid?.includes("@g.us");
}

/**
 * Filter reminder berdasarkan konteks:
 * - Dari grup → hanya tampil reminder dengan target grup itu
 * - Dari pribadi → tampil semua, atau bisa filter dengan arg
 */
function filterByContext(reminders, msg, arg = "") {
  const fromGroup = isFromGroup(msg);
  const groupJid = msg.key.remoteJid;

  if (fromGroup) {
    // Di grup: hanya tampil reminder yang targetnya grup ini
    return reminders.filter((r) => {
      const resolvedTarget = resolveTarget(r.target);
      return resolvedTarget === groupJid;
    });
  }

  // Di pribadi: default semua, bisa filter dengan arg
  if (arg === "grup" || arg === "group") {
    // !cek grup → tampil semua yang target grup
    return reminders.filter((r) => r.target?.includes("@g.us"));
  }

  if (arg === "saya" || arg === "aku" || arg === "me") {
    // !cek saya → tampil yang target nomor pengirim
    return reminders.filter((r) => {
      const resolvedTarget = resolveTarget(r.target);
      return resolvedTarget?.includes(process.env.OWNER_NUMBER || "");
    });
  }

  // Default dari pribadi: tampil semua
  return reminders;
}

async function handleCommand(sock, msg) {
  const senderJid = msg.key.remoteJid;
  const text = getMessageText(msg);

  if (!text.startsWith("!")) return;

  const fromJid = msg.key.participantPn || msg.key.senderPn || msg.key.participant || msg.key.remoteJid;

  if (!isAllowed(fromJid)) {
    console.log(`⛔ Akses ditolak dari: ${fromJid}`);
    return;
  }

  const [rawCmd, ...args] = text.slice(1).split(" ");
  const cmd = rawCmd.toLowerCase();
  const argStr = args.join(" ").trim();

  console.log(`📥 Command: !${cmd} ${argStr} (dari ${fromJid})`);

  try {
    switch (cmd) {
      // ── !help ────────────────────────────────────────────────────────────
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
            `!summary — ringkasan semua reminder aktif\n\n` +
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
            `🔒 Reminder auto-import tidak bisa di-!done/!edit/!hapus`,
        );
        break;

      // ── !damn / !setdamn ────────────────────────────────────────────────
      case "damn": {
        const stickerPath = resolveDamnStickerPath();
        try {
          const buffer = await fs.readFile(stickerPath);
          await sock.sendMessage(senderJid, { sticker: buffer }, { quoted: msg });
        } catch {
          await reply(sock, senderJid, msg, `❌ Sticker belum diset.\n\n` + `Reply ke *sticker/gambar* lalu kirim: *!setdamn*`);
        }
        break;
      }

      case "setdamn": {
        if (!isApprover(fromJid)) {
          await reply(sock, senderJid, msg, `⛔ Hanya ${approverLabel()} yang bisa set sticker.`);
          break;
        }

        const stickerPath = resolveDamnStickerPath();
        const quoted = buildQuotedMessageForDownload(msg);
        const sourceMsg = msg.message?.imageMessage ? msg : quoted;

        if (!sourceMsg) {
          await reply(sock, senderJid, msg, `❓ Caranya:\n\n` + `1) Reply ke sticker/gambar\n` + `2) Kirim: *!setdamn*`);
          break;
        }

        const mediaBuffer = await getMediaBuffer(sock, sourceMsg);
        if (!mediaBuffer) {
          await reply(sock, senderJid, msg, `❌ Tidak menemukan sticker/gambar di pesan yang direply.`);
          break;
        }

        const isSticker = !!sourceMsg.message?.stickerMessage;
        const outBuffer = isSticker ? mediaBuffer : await convertImageToSticker(mediaBuffer);

        await fs.mkdir(path.dirname(stickerPath), { recursive: true });
        await fs.writeFile(stickerPath, outBuffer);

        await reply(sock, senderJid, msg, `✅ Sticker diset! Coba ketik: *!damn*`);
        break;
      }

      // ── !approve / !reject (owner only) ──────────────────────────────────
      case "approve":
      case "reject": {
        if (!isApprover(fromJid)) {
          await reply(sock, senderJid, msg, `⛔ Hanya ${approverLabel()} yang bisa approve/reject.`);
          break;
        }
        if (!argStr) {
          await reply(sock, senderJid, msg, `❓ Format: *!${cmd} [code]*\n\nContoh: !${cmd} a1b2c3`);
          break;
        }

        const code = argStr.split(" ")[0].trim().toLowerCase();
        const pending = pendingDoneApprovals.get(code);
        if (!pending) {
          await reply(sock, senderJid, msg, `❌ Code *${code}* tidak ditemukan / sudah kadaluarsa.`);
          break;
        }

        if (Date.now() - pending.createdAt > DONE_APPROVAL_TTL_MS) {
          pendingDoneApprovals.delete(code);
          await reply(sock, senderJid, msg, `⌛ Code *${code}* sudah kadaluarsa.`);
          break;
        }

        if (cmd === "reject") {
          pendingDoneApprovals.delete(code);
          await reply(sock, senderJid, msg, `🚫 Ditolak: *[${pending.globalNo}] ${pending.task}*`);
          await sock.sendMessage(pending.replyJid, { text: `🚫 Permintaan !done *[${pending.globalNo}] ${pending.task}* ditolak oleh ${displayNameFromJid(fromJid)}.` });
          break;
        }

        // approve
        const reminders = await getReminders();
        const found = reminders.find((r) => `${r.tabName}:${r.rowIndex}` === pending.reminderRef);
        if (!found) {
          pendingDoneApprovals.delete(code);
          await reply(sock, senderJid, msg, `❌ Reminder untuk code *${code}* sudah tidak ada / mungkin sudah done.`);
          await sock.sendMessage(pending.replyJid, { text: `❌ Permintaan !done dibatalkan: reminder sudah tidak ada / mungkin sudah done.` });
          break;
        }

        const approverName = displayNameFromJid(fromJid);
        const result = await markAsDone(found);
        pendingDoneApprovals.delete(code);

        if (result.success) {
          await reply(sock, senderJid, msg, `✅ Disetujui: *[${pending.globalNo}] ${pending.task}*`);
          await sock.sendMessage(pending.replyJid, { text: `✅ Disetujui oleh ${approverName}. *[${pending.globalNo}] ${pending.task}* ditandai selesai.` });
        } else {
          await reply(sock, senderJid, msg, `❌ Gagal approve. Cek koneksi Google Sheets.`);
          await sock.sendMessage(pending.replyJid, { text: `❌ ${approverName} setuju, tapi gagal update status (Google Sheets error).` });
        }
        break;
      }

      // ── !cek ─────────────────────────────────────────────────────────────
      case "cek": {
        const allReminders = await getReminders();
        const filtered = filterByContext(allReminders, msg, argStr.toLowerCase());

        if (filtered.length === 0) {
          const hint = isFromGroup(msg) ? "Tidak ada reminder untuk grup ini." : "Tidak ada reminder aktif.";
          await reply(sock, senderJid, msg, `📋 ${hint}`);
          break;
        }

        const today = dayjs().startOf("day");
        const allMentions = [];

        const lines = filtered.map((r) => {
          const daysLeft = r.deadline.startOf("day").diff(today, "day");
          const deadlineStr = r.deadline.format("DD MMM YYYY");
          const statusEmoji = daysLeft < 0 ? "🔴" : daysLeft === 0 ? "🔥" : daysLeft <= 3 ? "⚠️" : "📌";
          const daysText = daysLeft < 0 ? `(telat ${Math.abs(daysLeft)} hari)` : daysLeft === 0 ? "(Hari ini!)" : `(${daysLeft} hari lagi)`;

          const { text: notesText, mentions } = parseMentions(r.notes || "");
          allMentions.push(...mentions);

          const readonlyTag = r.source === "auto" ? " 🔒" : "";
          return `${statusEmoji} *[${r.globalNo}] ${r.task}*${readonlyTag}\n   📅 ${deadlineStr} ${daysText}${notesText ? `\n   📝 ${notesText}` : ""}`;
        });

        const contextLabel = isFromGroup(msg) ? "Grup Ini" : argStr ? `Filter: ${argStr}` : "Semua";
        const lockHint = `_🔒 = auto-import (edit/hapus dibatasi; !done tetap bisa)_`;
        const approvalHint = requireOwnerApproval() && !isApprover(fromJid) ? `\n_!done butuh approval ${approverLabel()}_` : "";
        const fullText = `📋 *Reminder Aktif — ${contextLabel}*\n\n${lines.join("\n\n")}\n\n${lockHint}${approvalHint}`;
        await reply(sock, senderJid, msg, fullText, [...new Set(allMentions)]);
        break;
      }

      // ── !hari ─────────────────────────────────────────────────────────────
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

      // ── !kirim ────────────────────────────────────────────────────────────
      case "kirim":
        await reply(sock, senderJid, msg, "🔄 Mengirim reminder hari ini...");
        await triggerManualCheck(sock);
        await reply(sock, senderJid, msg, "✅ Selesai!");
        break;

      // ── !done ─────────────────────────────────────────────────────────────
      case "done": {
        if (!argStr) {
          await reply(sock, senderJid, msg, "❓ Format: *!done [no]*\n\nContoh: !done 3\n\nGunakan !cek untuk lihat nomor reminder.");
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

        // Optional: require owner approval for non-owner users
        if (requireOwnerApproval() && !isApprover(fromJid)) {
          const code = newApprovalCode();
          pendingDoneApprovals.set(code, {
            code,
            reminderRef: `${found.tabName}:${found.rowIndex}`,
            globalNo: targetNo,
            task: found.task,
            requestedBy: fromJid,
            replyJid: senderJid,
            createdAt: Date.now(),
          });

          const who = displayNameFromJid(fromJid);
          const targets = [...new Set(getApproverJids())];
          for (const jid of targets) {
            await sock.sendMessage(jid, {
              text:
                `🔐 *Request Done (butuh approval)*\n\n` +
                `Dari: ${who}\n` +
                `Reminder: *[${targetNo}] ${found.task}*\n\n` +
                `Balas:\n` +
                `• !approve ${code}\n` +
                `• !reject ${code}\n\n` +
                `_(Expired dalam ${Math.round(DONE_APPROVAL_TTL_MS / 60000)} menit)_`,
            });
          }
          await reply(sock, senderJid, msg, `🕒 Permintaan dikirim ke ${approverLabel()} untuk approval.\nCode: *${code}*`);
          break;
        }

        const who = displayNameFromJid(fromJid);
        const result = await markAsDone(found);
        if (result.success) {
          await reply(sock, senderJid, msg, `✅ *[${targetNo}] ${found.task}* ditandai selesai oleh ${who}!`);
        } else {
          await reply(sock, senderJid, msg, "❌ Gagal update status. Cek koneksi ke Google Sheets.");
        }
        break;
      }

      // ── !tambah ───────────────────────────────────────────────────────────
      case "tambah": {
        // Format: !tambah [task] | [deadline] | [H-notif] | [catatan]
        // Target auto-detect dari konteks
        if (!argStr) {
          await reply(
            sock,
            senderJid,
            msg,
            `📝 *Format tambah reminder:*\n\n` +
              `!tambah [task] | [deadline] | [H-notif] | [catatan]\n\n` +
              `*Contoh:*\n` +
              `!tambah Laporan Bulanan | 2025-01-31 | 7,3,1,0 | Segera kerjakan\n\n` +
              `📌 Target otomatis:\n` +
              `• Dari grup → reminder dikirim ke grup ini\n` +
              `• Dari pribadi → reminder dikirim ke kamu\n\n` +
              `📌 Reminder disimpan di tab *MyReminders*`,
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
          await reply(sock, senderJid, msg, `❌ Format deadline salah. Gunakan YYYY-MM-DD`);
          break;
        }

        const autoTarget = isFromGroup(msg) ? senderJid : fromJid?.includes("@s.whatsapp.net") ? fromJid : `${process.env.OWNER_NUMBER}@s.whatsapp.net`;

        const success = await addReminder({ task, deadline, target: autoTarget, notifyDays, notes });
        if (success) {
          const targetLabel = isFromGroup(msg) ? "grup ini" : "kamu";
          await reply(
            sock,
            senderJid,
            msg,
            `✅ Reminder berhasil ditambahkan ke *MyReminders*!\n\n` + `📌 *${task}*\n` + `📅 Deadline: ${dayjs(deadline).format("DD MMM YYYY")}\n` + `🔔 Notif di H-: ${notifyDays}\n` + `📨 Target: ${targetLabel}`,
          );
        } else {
          await reply(sock, senderJid, msg, "❌ Gagal menambah reminder.");
        }
        break;
      }

      // ── !edit ─────────────────────────────────────────────────────────────
      case "edit": {
        // Format: !edit [no] [field] [nilai baru]
        // Field: task, deadline, notif, catatan
        const editParts = argStr.match(/^(\d+)\s+(\w+)\s+(.+)$/);
        if (!editParts) {
          await reply(
            sock,
            senderJid,
            msg,
            `❓ *Format !edit:*\n\n` +
              `!edit [no] [field] [nilai baru]\n\n` +
              `*Field yang bisa diubah:*\n` +
              `• \`task\` — nama tugas\n` +
              `• \`deadline\` — tanggal (YYYY-MM-DD)\n` +
              `• \`notif\` — H-notif (contoh: 3,1,0)\n` +
              `• \`catatan\` — catatan\n\n` +
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
          await reply(sock, senderJid, msg, `✅ *[${editNo}] ${found.task}* berhasil diupdate!\n\n` + `📝 ${editField}: *${editValue}*`);
        } else if (result.reason === "readonly") {
          await reply(sock, senderJid, msg, `🔒 Reminder *[${editNo}]* adalah data auto-import, tidak bisa diubah dari bot.`);
        } else {
          await reply(sock, senderJid, msg, "❌ Gagal update. Cek koneksi ke Google Sheets.");
        }
        break;
      }

      // ── !hapus ────────────────────────────────────────────────────────────
      case "hapus": {
        if (!argStr) {
          await reply(sock, senderJid, msg, "❓ Format: *!hapus [no]*\n\nContoh: !hapus 3");
          break;
        }

        const hapusNo = parseInt(argStr);
        if (isNaN(hapusNo)) {
          await reply(sock, senderJid, msg, "❌ Nomor tidak valid. Contoh: !hapus 3");
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
        } else if (result.reason === "readonly") {
          await reply(sock, senderJid, msg, `🔒 Reminder *[${hapusNo}]* adalah data auto-import, tidak bisa dihapus dari bot.`);
        } else {
          await reply(sock, senderJid, msg, "❌ Gagal hapus. Cek koneksi ke Google Sheets.");
        }
        break;
      }

      // ── !summary ───────────────────────────────────────────────────────────
      case "summary":
        await reply(sock, senderJid, msg, "📋 Mengirim weekly summary...");
        await sendWeeklySummary(sock, senderJid);
        break;

      // ── !status ───────────────────────────────────────────────────────────
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
          `📊 *Status Bot*\n\n` + `🟢 Status: Online\n` + `⏱️ Uptime: ${hours}j ${minutes}m\n` + `📋 Reminder aktif: ${reminders.length}\n` + `⏰ Scheduler: ${cronExpr}\n` + `📅 Waktu sekarang: ${dayjs().format("DD/MM/YYYY HH:mm")} WIB`,
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

module.exports = { handleCommand };
