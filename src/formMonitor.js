/**
 * formMonitor.js
 *
 * Webhook-based form response monitor for Google Forms.
 * Google Apps Script sends data directly to the bot when a form
 * is submitted or edited, eliminating the need for cron polling
 * and state file persistence.
 *
 * Env vars: FORM_MONITOR_ENABLED, FORM_WEBHOOK_SECRET,
 *           FORM_SPREADSHEET_ID, FORM_SHEET_GID, FORM_NOTIFY_TARGET
 */

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Asia/Jakarta";

// ── In-memory state ────────────────────────────────────────────────────
let _sock = null;
let _enabled = true;

// ── Indonesian day/month names ─────────────────────────────────────────
const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const BULAN = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

/**
 * Parse timestamp string and format as "Hari, DD Bulan YYYY, HH:mm WIB"
 */
function formatTimestamp(raw) {
  if (!raw) return null;
  const parsed = dayjs(raw).tz(TZ);
  if (!parsed.isValid()) return raw;

  const hari = HARI[parsed.day()];
  const dd = parsed.format("DD");
  const bulan = BULAN[parsed.month()];
  const yyyy = parsed.year();
  const time = parsed.format("HH:mm");

  return `${hari}, ${dd} ${bulan} ${yyyy}, ${time} WIB`;
}

// ── Helpers ────────────────────────────────────────────────────────────
function getSheetLink() {
  const spreadsheetId = process.env.FORM_SPREADSHEET_ID || "";
  const gid = process.env.FORM_SHEET_GID || "0";
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}`;
}

function resolveNotifyTarget() {
  const target = process.env.FORM_NOTIFY_TARGET || "owner";
  if (target === "owner") {
    return `${process.env.OWNER_NUMBER}@s.whatsapp.net`;
  }
  return target;
}

// ── Notification formatting ────────────────────────────────────────────
function formatNewResponse(data) {
  const timestamp = formatTimestamp(data.timestamp);
  const nama = data.nama || "-";
  const divisi = data.divisi || "-";
  const jabatan = data.jabatan || "-";
  const alasan = data.alasan || "";
  const alasanTrunc = alasan.length > 100 ? alasan.substring(0, 100) + "..." : alasan;

  let text = `\uD83D\uDCCB *Response Baru - Form HIMASIF 45*\n`;
  if (timestamp) {
    text += `\n\uD83D\uDCC5 ${timestamp}`;
  }
  text += `\n\uD83D\uDC64 Nama: ${nama}`;
  text += `\n\uD83C\uDFE2 Divisi: ${divisi}`;
  text += `\n\uD83C\uDFAF Jabatan: ${jabatan}`;
  if (alasanTrunc) {
    text += `\n\uD83D\uDCAC Alasan: ${alasanTrunc}`;
  }
  text += `\n\n\uD83D\uDD17 ${getSheetLink()}`;
  return text;
}

function formatEditedResponse(data) {
  const nama = data.nama || "-";
  const divisi = data.divisi || "-";
  const jabatan = data.jabatan || "-";

  let text = `\u270F\uFE0F *Response Diedit - Form HIMASIF 45*\n`;
  text += `\n\uD83D\uDC64 Nama: ${nama}`;
  text += `\n\uD83C\uDFE2 Divisi: ${divisi}`;
  text += `\n\uD83C\uDFAF Jabatan: ${jabatan}`;
  text += `\n\n\uD83D\uDD17 ${getSheetLink()}`;
  return text;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Initialize the form monitor in webhook mode.
 * Just stores the sock reference -- no cron, no state file.
 */
function initFormMonitor(sock) {
  _sock = sock;
  _enabled = (process.env.FORM_MONITOR_ENABLED || "true").toLowerCase() !== "false";
  console.log(`\uD83D\uDCCB formMonitor: webhook mode ready (enabled: ${_enabled})`);
}

/**
 * Handle incoming webhook data from Google Apps Script.
 * @param {object} sock - Baileys socket
 * @param {object} data - { type: "new"|"edit", timestamp, nama, divisi, jabatan, alasan }
 * @returns {{ success: boolean, reason?: string }}
 */
async function handleFormWebhook(sock, data) {
  if (!sock) {
    return { success: false, reason: "WhatsApp socket not available" };
  }

  if (!data || !data.type) {
    return { success: false, reason: "Missing type field in webhook data" };
  }

  const type = data.type.toLowerCase();
  if (type !== "new" && type !== "edit") {
    return { success: false, reason: `Unknown type: ${data.type}` };
  }

  const text = type === "new"
    ? formatNewResponse(data)
    : formatEditedResponse(data);

  const targetJid = resolveNotifyTarget();

  try {
    await sock.sendMessage(targetJid, { text });
    console.log(`\uD83D\uDCCB formMonitor: sent ${type} notification`);
    return { success: true };
  } catch (err) {
    console.error(`\u274C formMonitor: failed to send notification:`, err.message);
    return { success: false, reason: err.message };
  }
}

/**
 * Get current form monitor status.
 */
function getFormStatus() {
  const envEnabled = (process.env.FORM_MONITOR_ENABLED || "true").toLowerCase() !== "false";
  return {
    enabled: envEnabled && _enabled,
    mode: "webhook",
    notifyTarget: process.env.FORM_NOTIFY_TARGET || "owner",
    spreadsheetId: process.env.FORM_SPREADSHEET_ID || "(not set)",
  };
}

/**
 * Enable or disable the form monitor.
 */
function setFormEnabled(enabled) {
  _enabled = Boolean(enabled);
  return _enabled;
}

module.exports = {
  initFormMonitor,
  handleFormWebhook,
  getFormStatus,
  setFormEnabled,
};
