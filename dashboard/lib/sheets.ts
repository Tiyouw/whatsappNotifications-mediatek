import { google } from "googleapis";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(customParseFormat);

export interface Reminder {
  no: string;
  task: string;
  deadline: string;
  target: string;
  notifyDays: number[];
  notes: string;
  status: string;
  source: "auto" | "manual";
  approval: string;
}

const MONTH_NAMES = [
  "JANUARI",
  "FEBRUARI",
  "MARET",
  "APRIL",
  "MEI",
  "JUNI",
  "JULI",
  "AGUSTUS",
  "SEPTEMBER",
  "OKTOBER",
  "NOVEMBER",
  "DESEMBER",
];

const COL = {
  NO: 0,
  TASK: 1,
  DEADLINE: 2,
  TARGET: 3,
  NOTIFY: 4,
  NOTES: 5,
  STATUS: 6,
  APPROVAL: 8,
};

function isValidRow(row: string[]): boolean {
  if (!row[COL.TASK] || row[COL.TASK].trim().length < 2) return false;
  const deadline = row[COL.DEADLINE]?.trim();
  if (!deadline || !dayjs(deadline, "YYYY-MM-DD", true).isValid()) return false;
  const taskUpper = row[COL.TASK].trim().toUpperCase();
  if (MONTH_NAMES.includes(taskUpper)) return false;
  return true;
}

function getSheetsClient() {
  const credentialsJson = process.env.GOOGLE_CREDENTIALS;
  if (!credentialsJson) {
    throw new Error("GOOGLE_CREDENTIALS environment variable is not set");
  }

  const credentials = JSON.parse(credentialsJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  return google.sheets({ version: "v4", auth });
}

async function readTab(
  sheets: ReturnType<typeof google.sheets>,
  tabName: string,
  source: "auto" | "manual"
): Promise<Reminder[]> {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error("SPREADSHEET_ID environment variable is not set");
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A2:I`,
  });

  const rows = (res.data.values || []) as string[][];
  const reminders: Reminder[] = [];

  for (const row of rows) {
    if (!isValidRow(row)) continue;

    const status = row[COL.STATUS]?.toLowerCase().trim() || "active";

    const notifyDaysRaw = row[COL.NOTIFY] || "7,3,1,0";
    const notifyDays = notifyDaysRaw
      .toString()
      .split(",")
      .map((d) => parseInt(d.trim()))
      .filter((d) => !isNaN(d));

    reminders.push({
      no: row[COL.NO] || "",
      task: row[COL.TASK].trim(),
      deadline: row[COL.DEADLINE].trim(),
      target: row[COL.TARGET]?.trim() || "",
      notifyDays,
      notes: row[COL.NOTES]?.trim() || "",
      status,
      source,
      approval: row[COL.APPROVAL]?.trim() || "",
    });
  }

  return reminders;
}

export async function getReminders(): Promise<Reminder[]> {
  const sheets = getSheetsClient();
  const autoTab = process.env.SHEET_REMINDER_TAB || "Reminders";
  const manualTab = process.env.SHEET_MANUAL_TAB || "MyReminders";

  const [autoReminders, manualReminders] = await Promise.all([
    readTab(sheets, autoTab, "auto"),
    readTab(sheets, manualTab, "manual"),
  ]);

  return [...autoReminders, ...manualReminders];
}
