/**
 * formMonitor.js
 *
 * Monitors a Google Form response spreadsheet for new or edited rows.
 * Sends WhatsApp notifications when new responses are submitted or
 * existing responses are edited.
 *
 * IMPORTANT: The service account email (from credentials.json) needs
 * Editor or Viewer access to the form response spreadsheet.
 * Share the spreadsheet with the service account email found in
 * credentials.json → client_email.
 *
 * State: data/formState.json (auto-created if missing)
 * Env vars: FORM_MONITOR_ENABLED, FORM_SPREADSHEET_ID, FORM_SHEET_TAB,
 *           FORM_SHEET_GID, FORM_CHECK_CRON, FORM_NOTIFY_TARGET,
 *           FORM_STATE_PATH
 */

const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const { google } = require("googleapis");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Asia/Jakarta";

// ── Path resolution (same pattern as reactionMap.js) ───────────────────
function resolveStatePath() {
  const raw = process.env.FORM_STATE_PATH;
  if (process.env.NODE_ENV === "production") {
    if (!raw || !path.isAbsolute(raw)) {
      const msg =
        "❌ FATAL: FORM_STATE_PATH must be set to an absolute path when " +
        `NODE_ENV=production (got ${JSON.stringify(raw)}). Check fly.toml [env] ` +
        "and run `flyctl secrets list` to confirm no secret is shadowing it.";
      console.error(msg);
      process.exit(1);
    }
    return raw;
  }
  if (!raw) return path.resolve(__dirname, "..", "data", "formState.json");
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, "..", raw);
}

const STATE_PATH = resolveStatePath();

// ── State persistence ──────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    }
  } catch {
    console.warn("⚠️  formMonitor: failed to read state, starting fresh");
  }
  return {
    lastRowCount: 0,
    lastChecked: null,
    rowHashes: {},
    enabled: true,
  };
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("❌ formMonitor: failed to write state:", err.message);
  }
}

// ── Simple hash function ───────────────────────────────────────────────
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString(36);
}

// ── Google Sheets client ───────────────────────────────────────────────
let sheetsClient = null;

async function getFormSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const credPath = path.resolve(process.env.GOOGLE_CREDENTIALS_PATH || "./credentials.json");
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

// ── Helpers ────────────────────────────────────────────────────────────
function resolveNotifyTarget() {
  const target = process.env.FORM_NOTIFY_TARGET || "owner";
  if (target === "owner") {
    return `${process.env.OWNER_NUMBER}@s.whatsapp.net`;
  }
  return target;
}

function isMonitorEnabled() {
  const envEnabled = (process.env.FORM_MONITOR_ENABLED || "true").toLowerCase() !== "false";
  const state = loadState();
  return envEnabled && state.enabled;
}

// ── Indonesian day/month names ─────────────────────────────────────────
const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const BULAN = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

/**
 * Parse Google Forms timestamp (e.g. "5/26/2026 19:30:00") and format as
 * "Hari, DD Bulan YYYY, HH:mm WIB"
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

// ── Notification formatting ────────────────────────────────────────────
function getSheetLink() {
  const spreadsheetId = process.env.FORM_SPREADSHEET_ID || "";
  const gid = process.env.FORM_SHEET_GID || "1203386562";
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}`;
}

function formatNewResponse(row) {
  // Columns: [0]Timestamp, [1]Nama, [2]Divisi, [3]Jabatan, [4]Alasan, [5]Kurang, [6]Diperbaiki
  const timestamp = formatTimestamp(row[0]);
  const nama = row[1] || "-";
  const divisi = row[2] || "-";
  const jabatan = row[3] || "-";
  const alasan = row[4] || "";
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

function formatEditedResponse(row) {
  // Columns: [0]Timestamp, [1]Nama, [2]Divisi, [3]Jabatan, [4]Alasan, [5]Kurang, [6]Diperbaiki
  const nama = row[1] || "-";
  const divisi = row[2] || "-";
  const jabatan = row[3] || "-";

  let text = `\u270F\uFE0F *Response Diedit - Form HIMASIF 45*\n`;
  text += `\n\uD83D\uDC64 Nama: ${nama}`;
  text += `\n\uD83C\uDFE2 Divisi: ${divisi}`;
  text += `\n\uD83C\uDFAF Jabatan: ${jabatan}`;
  text += `\n\n\uD83D\uDD17 ${getSheetLink()}`;
  return text;
}

// ── Stored sock reference ──────────────────────────────────────────────
let _sock = null;
let _cronJob = null;

// ── Core polling logic ─────────────────────────────────────────────────
async function pollFormResponses() {
  if (!isMonitorEnabled()) return;

  const spreadsheetId = process.env.FORM_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.warn("📋 formMonitor: FORM_SPREADSHEET_ID not set, skipping poll");
    return;
  }

  const sheetTab = process.env.FORM_SHEET_TAB || "Form Responses 1";
  const state = loadState();

  try {
    const sheets = await getFormSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetTab}'!A2:G`,
    });

    const rows = res.data.values || [];
    state.lastChecked = new Date().toISOString();

    // First run: store current state without sending notifications
    if (state.lastRowCount === 0 && Object.keys(state.rowHashes).length === 0) {
      console.log(`📋 formMonitor: first run, storing ${rows.length} existing rows`);
      state.lastRowCount = rows.length;
      const hashes = {};
      for (let i = 0; i < rows.length; i++) {
        const rowKey = String(i + 2); // Row 2 is index 0, etc.
        hashes[rowKey] = simpleHash(rows[i].join("|"));
      }
      state.rowHashes = hashes;
      saveState(state);
      return;
    }

    const targetJid = resolveNotifyTarget();
    const currentHashes = {};
    const notifications = [];

    for (let i = 0; i < rows.length; i++) {
      const rowKey = String(i + 2);
      const hash = simpleHash(rows[i].join("|"));
      currentHashes[rowKey] = hash;

      if (i >= state.lastRowCount) {
        // New row
        notifications.push({ type: "new", row: rows[i] });
      } else if (state.rowHashes[rowKey] && state.rowHashes[rowKey] !== hash) {
        // Edited row
        notifications.push({ type: "edit", row: rows[i] });
      }
    }

    // Send notifications
    if (_sock && notifications.length > 0) {
      for (const notif of notifications) {
        const text = notif.type === "new"
          ? formatNewResponse(notif.row)
          : formatEditedResponse(notif.row);
        await _sock.sendMessage(targetJid, { text });
      }
      console.log(`📋 formMonitor: sent ${notifications.length} notification(s)`);
    }

    // Update state
    state.lastRowCount = rows.length;
    state.rowHashes = currentHashes;
    saveState(state);
  } catch (err) {
    console.error("❌ formMonitor: poll error:", err.message);
    saveState(state);
  }
}

// ── Public API ─────────────────────────────────────────────────────────
function startFormMonitor(sock) {
  _sock = sock;

  if ((process.env.FORM_MONITOR_ENABLED || "true").toLowerCase() === "false") {
    console.log("📋 formMonitor: disabled via FORM_MONITOR_ENABLED=false");
    return;
  }

  const spreadsheetId = process.env.FORM_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.log("📋 formMonitor: FORM_SPREADSHEET_ID not set, monitor inactive");
    return;
  }

  const cronExpr = process.env.FORM_CHECK_CRON || "*/5 * * * *";

  if (_cronJob) {
    _cronJob.stop();
  }

  _cronJob = cron.schedule(cronExpr, () => {
    pollFormResponses().catch((err) => {
      console.error("❌ formMonitor: unhandled poll error:", err.message);
    });
  });

  const sheetTab = process.env.FORM_SHEET_TAB || "Form Responses 1";
  console.log(`📋 formMonitor: started monitoring "${sheetTab}" (cron: ${cronExpr})`);
}

async function checkFormNow(sock) {
  const activeSock = sock || _sock;
  if (activeSock) _sock = activeSock;

  const spreadsheetId = process.env.FORM_SPREADSHEET_ID;
  if (!spreadsheetId) {
    return { success: false, reason: "FORM_SPREADSHEET_ID not set" };
  }

  try {
    await pollFormResponses();
    return { success: true, message: "Check completed" };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

function getFormStatus() {
  const state = loadState();
  const envEnabled = (process.env.FORM_MONITOR_ENABLED || "true").toLowerCase() !== "false";
  const cronExpr = process.env.FORM_CHECK_CRON || "*/5 * * * *";
  const sheetTab = process.env.FORM_SHEET_TAB || "Form Responses 1";

  return {
    enabled: envEnabled && state.enabled,
    envEnabled,
    stateEnabled: state.enabled,
    sheetTab,
    cronExpression: cronExpr,
    lastChecked: state.lastChecked || null,
    lastRowCount: state.lastRowCount || 0,
    notifyTarget: process.env.FORM_NOTIFY_TARGET || "owner",
  };
}

function setFormEnabled(enabled) {
  const state = loadState();
  state.enabled = Boolean(enabled);
  saveState(state);
  return state.enabled;
}

module.exports = {
  startFormMonitor,
  checkFormNow,
  getFormStatus,
  setFormEnabled,
};
