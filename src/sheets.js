const { google } = require('googleapis')
const path = require('path')
const dayjs = require('dayjs')

let sheetsClient = null

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient
  const credPath = path.resolve(process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json')
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  sheetsClient = google.sheets({ version: 'v4', auth })
  return sheetsClient
}

// Kolom: A:No B:Nama Task C:Deadline D:Target E:H-Notif F:Catatan G:Status
const COL = { NO: 0, TASK: 1, DEADLINE: 2, TARGET: 3, NOTIFY: 4, NOTES: 5, STATUS: 6 }

/**
 * Validasi apakah sebuah baris adalah data reminder yang valid
 * Skip: baris kosong, baris pembatas bulan (MEI, APRIL, dll), deadline tidak valid
 */
function isValidRow(row) {
  if (!row[COL.TASK] || row[COL.TASK].trim().length < 2) return false

  const deadline = row[COL.DEADLINE]?.trim()
  if (!deadline) return false
  if (!dayjs(deadline).isValid()) return false

  // Tolak label bulan
  const taskUpper = row[COL.TASK].trim().toUpperCase()
  const bulanList = ['JANUARI','FEBRUARI','MARET','APRIL','MEI','JUNI',
                     'JULI','AGUSTUS','SEPTEMBER','OKTOBER','NOVEMBER','DESEMBER']
  if (bulanList.includes(taskUpper)) return false

  return true
}

/**
 * Baca satu tab dan return list reminder
 */
async function readTab(sheets, tabName, source = 'auto') {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${tabName}!A2:G`,
    })
    const rows = res.data.values || []
    const reminders = []

    // Default group JID dari .env jika kolom target kosong
    const defaultTarget = process.env.DEFAULT_GROUP_JID || process.env.OWNER_NUMBER || ''

    for (const row of rows) {
      // Fix 1: Skip baris tidak valid
      if (!isValidRow(row)) {
        if (row[COL.TASK]?.trim()) {
          console.log(`   ⏭️  Skip baris tidak valid: "${row[COL.TASK]}"`)
        }
        continue
      }

      // Fix 2: Default status = 'active' jika kosong
      const status = row[COL.STATUS]?.toLowerCase().trim() || 'active'
      if (status === 'done' || status === 'skip') continue

      const deadline = row[COL.DEADLINE].trim()

      const notifyDaysRaw = row[COL.NOTIFY] || process.env.NOTIFY_DAYS_BEFORE || '7,3,1,0'
      const notifyDays = notifyDaysRaw
        .toString()
        .split(',')
        .map((d) => parseInt(d.trim()))
        .filter((d) => !isNaN(d))

      // Fix 2: Default target = DEFAULT_GROUP_JID jika kosong
      const target = row[COL.TARGET]?.trim() || defaultTarget

      reminders.push({
        rowIndex: rows.indexOf(row) + 2,
        tabName,
        source,
        no: row[COL.NO] || '',
        task: row[COL.TASK].trim(),
        deadline: dayjs(deadline),
        rawDeadline: deadline,
        target,
        notifyDays,
        notes: row[COL.NOTES]?.trim() || '',
        status,
      })
    }

    return reminders
  } catch (err) {
    console.error(`❌ Error membaca tab "${tabName}":`, err.message)
    return []
  }
}

/**
 * Ambil semua reminder dari kedua tab, gabung & beri nomor urut global
 */
async function getReminders() {
  const sheets = await getSheetsClient()
  const autoTab = process.env.SHEET_REMINDER_TAB || 'Reminders'
  const manualTab = process.env.SHEET_MANUAL_TAB || 'MyReminders'

  const [autoReminders, manualReminders] = await Promise.all([
    readTab(sheets, autoTab, 'auto'),
    readTab(sheets, manualTab, 'manual'),
  ])

  const all = [...autoReminders, ...manualReminders]
  all.forEach((r, i) => { r.globalNo = i + 1 })
  return all
}

/**
 * Ambil reminder yang due hari ini
 * Fix 3: Sertakan reminder OVERDUE (telat tapi belum done) max 7 hari ke belakang
 */
async function getDueReminders() {
  const reminders = await getReminders()
  const today = dayjs().startOf('day')
  const dueList = []
  const seen = new Set() // hindari duplikat jika somehow ada reminder sama

  for (const r of reminders) {
    const deadline = r.deadline.startOf('day')
    const daysLeft = deadline.diff(today, 'day')

    const isDueToday = r.notifyDays.includes(daysLeft)

    // Fix 3: Overdue carry-forward — tetap kirim max 7 hari setelah deadline
    const isOverdue = daysLeft < 0 && daysLeft >= -7

    if ((isDueToday || isOverdue) && !seen.has(r.globalNo)) {
      seen.add(r.globalNo)
      dueList.push({ ...r, daysLeft })
    }
  }

  return dueList
}

/**
 * Tandai reminder sebagai done
 */
async function markAsDone(reminder) {
  if (reminder.source === 'auto') return { success: false, reason: 'readonly' }

  try {
    const sheets = await getSheetsClient()
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${reminder.tabName}!G${reminder.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['done']] },
    })
    console.log(`✅ Row ${reminder.rowIndex} ditandai done`)
    return { success: true }
  } catch (err) {
    console.error('❌ Error update status:', err.message)
    return { success: false, reason: 'error' }
  }
}

/**
 * Edit satu field reminder
 */
async function editReminder(reminder, field, newValue) {
  if (reminder.source === 'auto') return { success: false, reason: 'readonly' }

  const fieldMap = {
    task: 'B', nama: 'B',
    deadline: 'C', tanggal: 'C',
    notif: 'E',
    catatan: 'F', notes: 'F',
  }

  const col = fieldMap[field.toLowerCase()]
  if (!col) return { success: false, reason: 'invalid_field' }

  try {
    const sheets = await getSheetsClient()
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${reminder.tabName}!${col}${reminder.rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newValue]] },
    })
    return { success: true }
  } catch (err) {
    console.error('❌ Error edit reminder:', err.message)
    return { success: false, reason: 'error' }
  }
}

/**
 * Hapus reminder (set status = skip)
 */
async function deleteReminder(reminder) {
  if (reminder.source === 'auto') return { success: false, reason: 'readonly' }

  try {
    const sheets = await getSheetsClient()
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${reminder.tabName}!G${reminder.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['skip']] },
    })
    return { success: true }
  } catch (err) {
    console.error('❌ Error hapus reminder:', err.message)
    return { success: false, reason: 'error' }
  }
}

/**
 * Tambah reminder baru ke tab manual
 */
async function addReminder({ task, deadline, target, notifyDays = '7,3,1,0', notes = '' }) {
  try {
    const sheets = await getSheetsClient()
    const manualTab = process.env.SHEET_MANUAL_TAB || 'MyReminders'

    const existing = await readTab(sheets, manualTab, 'manual')
    const nextNo = existing.length + 1

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${manualTab}!A:G`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[nextNo, task, deadline, target, notifyDays, notes, 'active']],
      },
    })
    return true
  } catch (err) {
    console.error('❌ Error menambah reminder:', err.message)
    return false
  }
}

module.exports = {
  getReminders,
  getDueReminders,
  markAsDone,
  addReminder,
  editReminder,
  deleteReminder,
}