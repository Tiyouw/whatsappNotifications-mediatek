const { google } = require("googleapis");
const path = require("path");
const dayjs = require("dayjs");

let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const credPath = path.resolve(process.env.GOOGLE_CREDENTIALS_PATH || "./credentials.json");
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

// Kolom: A:No B:Nama Task C:Deadline D:Target E:H-Notif F:Catatan G:Status
const COL = { NO: 0, TASK: 1, DEADLINE: 2, TARGET: 3, NOTIFY: 4, NOTES: 5, STATUS: 6 };

/**
 * Skip baris kosong, pembatas bulan (MEI, APRIL, dll), atau deadline tidak valid
 */
function isValidRow(row) {
  if (!row[COL.TASK] || row[COL.TASK].trim().length < 2) return false;
  const deadline = row[COL.DEADLINE]?.trim();
  if (!deadline || !dayjs(deadline).isValid()) return false;
  const taskUpper = row[COL.TASK].trim().toUpperCase();
  const bulanList = ["JANUARI", "FEBRUARI", "MARET", "APRIL", "MEI", "JUNI", "JULI", "AGUSTUS", "SEPTEMBER", "OKTOBER", "NOVEMBER", "DESEMBER"];
  if (bulanList.includes(taskUpper)) return false;
  return true;
}

async function readTab(sheets, tabName, source = "auto") {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${tabName}!A2:G`,
    });
    const rows = res.data.values || [];
    const reminders = [];
    const defaultTarget = process.env.DEFAULT_GROUP_JID || process.env.OWNER_NUMBER || "";

    for (const [offset, row] of rows.entries()) {
      if (!isValidRow(row)) {
        if (row[COL.TASK]?.trim()) console.log(`   ⏭️  Skip: "${row[COL.TASK]}"`);
        continue;
      }

      const status = row[COL.STATUS]?.toLowerCase().trim() || "active";
      if (status === "done" || status === "skip") continue;

      const notifyDaysRaw = row[COL.NOTIFY] || process.env.NOTIFY_DAYS_BEFORE || "7,3,1,0";
      const notifyDays = notifyDaysRaw
        .toString()
        .split(",")
        .map((d) => parseInt(d.trim()))
        .filter((d) => !isNaN(d));

      const target = row[COL.TARGET]?.trim() || defaultTarget;

      reminders.push({
        rowIndex: offset + 2,
        tabName,
        source,
        no: row[COL.NO] || "",
        task: row[COL.TASK].trim(),
        deadline: dayjs(row[COL.DEADLINE].trim()),
        rawDeadline: row[COL.DEADLINE].trim(),
        target,
        notifyDays,
        notes: row[COL.NOTES]?.trim() || "",
        status,
      });
    }
    return reminders;
  } catch (err) {
    console.error(`❌ Error membaca tab "${tabName}":`, err.message);
    return [];
  }
}

async function getReminders() {
  const sheets = await getSheetsClient();
  const autoTab = process.env.SHEET_REMINDER_TAB || "Reminders";
  const manualTab = process.env.SHEET_MANUAL_TAB || "MyReminders";

  const [autoReminders, manualReminders] = await Promise.all([readTab(sheets, autoTab, "auto"), readTab(sheets, manualTab, "manual")]);

  const all = [...autoReminders, ...manualReminders];
  all.forEach((r, i) => {
    r.globalNo = i + 1;
  });
  return all;
}

async function getDueReminders() {
  const reminders = await getReminders();
  const today = dayjs().startOf("day");
  const dueList = [];
  const seen = new Set();

  for (const r of reminders) {
    const daysLeft = r.deadline.startOf("day").diff(today, "day");
    const isDueToday = r.notifyDays.includes(daysLeft);
    const isOverdue = daysLeft < 0 && daysLeft >= -7;

    if ((isDueToday || isOverdue) && !seen.has(r.globalNo)) {
      seen.add(r.globalNo);
      dueList.push({ ...r, daysLeft });
    }
  }
  return dueList;
}

/**
 * Tandai done — hanya untuk tab MyReminders (manual)
 * Tab Reminders (auto-import) adalah read-only dari Google Sheets API,
 * tidak bisa ditulis → user harus ubah langsung di sheet aslinya
 */
async function markAsDone(reminder) {
  // Hapus blok if (reminder.source === 'auto') — kolom Status bisa ditulis
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${reminder.tabName}!G${reminder.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [["done"]] },
    });
    console.log(`✅ Row ${reminder.rowIndex} tab "${reminder.tabName}" → done`);
    return { success: true };
  } catch (err) {
    console.error("❌ Error markAsDone:", err.message);
    return { success: false, reason: err.message };
  }
}

async function editReminder(reminder, field, newValue) {
  const fieldMap = {
    task: "B",
    nama: "B",
    deadline: "C",
    tanggal: "C",
    notif: "E",
    catatan: "F",
    notes: "F",
  };
  const col = fieldMap[field.toLowerCase()];
  if (!col) return { success: false, reason: "invalid_field" };
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${reminder.tabName}!${col}${reminder.rowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[newValue]] },
    });
    return { success: true };
  } catch (err) {
    console.error("❌ Error editReminder:", err.message);
    return { success: false, reason: err.message };
  }
}

async function deleteReminder(reminder) {
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${reminder.tabName}!G${reminder.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [["skip"]] },
    });
    return { success: true };
  } catch (err) {
    console.error("❌ Error deleteReminder:", err.message);
    return { success: false, reason: err.message };
  }
}

async function addReminder({ task, deadline, target, notifyDays = "7,3,1,0", notes = "" }) {
  try {
    const sheets = await getSheetsClient();
    const manualTab = process.env.SHEET_MANUAL_TAB || "MyReminders";
    const existing = await readTab(sheets, manualTab, "manual");
    const nextNo = existing.length + 1;
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${manualTab}!A:G`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[nextNo, task, deadline, target, notifyDays, notes, "active"]] },
    });
    return true;
  } catch (err) {
    console.error("❌ Error addReminder:", err.message);
    return false;
  }
}

module.exports = { getReminders, getDueReminders, markAsDone, addReminder, editReminder, deleteReminder };
