const { google } = require('googleapis')
const path = require('path')
const dayjs = require('dayjs')

let sheetsClient = null
let sheetTitlesCache = null
const tabSchemaCache = new Map()

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

function normalizeHeader(value) {
  return (value || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\w-]/g, '')
}

function columnToLetter(columnIndex1Based) {
  let n = columnIndex1Based
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

async function getTabSchema(sheets, tabName) {
  const cached = tabSchemaCache.get(tabName)
  if (cached) return cached

  // Pull header row (wide range to tolerate extra columns like PJ/Approval).
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${tabName}!A1:Z1`,
  })
  const headerRow = res.data.values?.[0] || []

  const headerIndex = new Map()
  for (let i = 0; i < headerRow.length; i++) {
    const key = normalizeHeader(headerRow[i])
    if (!key) continue
    if (!headerIndex.has(key)) headerIndex.set(key, i)
  }

  function findIndex(candidates) {
    for (const c of candidates) {
      const idx = headerIndex.get(normalizeHeader(c))
      if (typeof idx === 'number') return idx
    }
    return null
  }

  const schema = {
    no: findIndex(['no', 'nomor']),
    task: findIndex(['namatask', 'nama', 'task', 'tugas']),
    deadline: findIndex(['deadline', 'tanggal']),
    target: findIndex(['target']),
    notify: findIndex(['h-notif', 'hnotif', 'notif']),
    notes: findIndex(['catatan', 'notes', 'note']),
    status: findIndex(['status']),
    approval: findIndex(['approval', 'approve', 'approvedby']),
    headerLength: headerRow.length,
  }

  tabSchemaCache.set(tabName, schema)
  return schema
}

async function ensureTabHeader(sheets, tabName, headerName) {
  const schema = await getTabSchema(sheets, tabName)
  if (schema.approval !== null && headerName.toLowerCase() === 'approval') return schema

  // Find first empty header cell within A1:Z1, else append after current headers.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${tabName}!A1:Z1`,
  })
  const headerRow = res.data.values?.[0] || []

  let idx = headerRow.findIndex((v) => !normalizeHeader(v))
  if (idx === -1) idx = headerRow.length

  const colLetter = columnToLetter(idx + 1)
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${tabName}!${colLetter}1:${colLetter}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [[headerName]] },
  })

  // Refresh schema cache for this tab.
  tabSchemaCache.delete(tabName)
  return getTabSchema(sheets, tabName)
}

function normalizeKeyPart(value) {
  return (value ?? '').toString().trim()
}

function getReminderKey({ source, tabName, no, rowIndex, rawDeadline }) {
  const noPart = normalizeKeyPart(no) || `row${rowIndex}`
  return `${normalizeKeyPart(source)}|${normalizeKeyPart(tabName)}|${noPart}|${normalizeKeyPart(rawDeadline)}`
}

async function getSheetTitles(sheets) {
  if (sheetTitlesCache) return sheetTitlesCache
  const res = await sheets.spreadsheets.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    fields: 'sheets(properties(title))',
  })
  sheetTitlesCache = (res.data.sheets || []).map((s) => s.properties?.title).filter(Boolean)
  return sheetTitlesCache
}

async function ensureTabExists(sheets, tabName) {
  const titles = await getSheetTitles(sheets)
  if (titles.includes(tabName)) return

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SPREADSHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  })

  // Refresh cache
  sheetTitlesCache = null
  await getSheetTitles(sheets)
}

async function ensureHeaderCell(sheets, tabName, columnLetter, expectedValue) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${tabName}!${columnLetter}1:${columnLetter}1`,
  })
  const current = (res.data.values?.[0]?.[0] || '').toString().trim()
  if (current) return
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${tabName}!${columnLetter}1:${columnLetter}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [[expectedValue]] },
  })
}

async function loadOverrides(sheets) {
  const overrideTab = process.env.SHEET_OVERRIDE_TAB || 'BotOverrides'
  await ensureTabExists(sheets, overrideTab)
  // Column E will store "Approval" name
  await ensureHeaderCell(sheets, overrideTab, 'A', 'Key')
  await ensureHeaderCell(sheets, overrideTab, 'B', 'Status')
  await ensureHeaderCell(sheets, overrideTab, 'C', 'UpdatedAt')
  await ensureHeaderCell(sheets, overrideTab, 'D', 'UpdatedBy')
  await ensureHeaderCell(sheets, overrideTab, 'E', 'Approval')

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${overrideTab}!A2:E`,
  })

  const rows = res.data.values || []
  const overrides = new Map()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const key = normalizeKeyPart(row[0])
    const status = normalizeKeyPart(row[1]).toLowerCase()
    if (!key) continue
    if (!status) continue
    overrides.set(key, status)
  }

  return { overrideTab, overrides }
}

async function upsertOverride(sheets, key, status, updatedBy = '', approvedByName = '') {
  const { overrideTab } = await loadOverrides(sheets)

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${overrideTab}!A2:A`,
  })
  const rows = res.data.values || []

  const now = dayjs().format('YYYY-MM-DD HH:mm:ss')
  const rowValues = [[key, status, now, updatedBy, approvedByName]]

  // Find existing key (A column)
  let existingRowIndex = null
  for (let i = 0; i < rows.length; i++) {
    if (normalizeKeyPart(rows[i][0]) === key) {
      existingRowIndex = i + 2
      break
    }
  }

  if (existingRowIndex) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${overrideTab}!A${existingRowIndex}:E${existingRowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: rowValues },
    })
    return { mode: 'update' }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${overrideTab}!A:E`,
    valueInputOption: 'RAW',
    requestBody: { values: rowValues },
  })
  return { mode: 'append' }
}

/**
 * Baca satu tab dan return list reminder
 * @param {string} tabName
 * @param {string} source - label sumber ('auto' | 'manual')
 */
async function readTab(sheets, tabName, source = 'auto', overrides = null) {
  try {
    const schema = await getTabSchema(sheets, tabName)
    const required = ['task', 'deadline', 'status']
    for (const key of required) {
      if (schema[key] === null) {
        console.error(`❌ Tab "${tabName}" tidak punya kolom wajib: ${key}. Pastikan header row ada.`)
        return []
      }
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${tabName}!A2:Z`,
    })
    const rows = res.data.values || []
    const reminders = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const status = row[schema.status]?.toLowerCase() || 'active'
      if (status === 'done' || status === 'skip') continue

      const deadline = row[schema.deadline]?.trim()
      if (!deadline) continue

      const notifyDaysRaw = (schema.notify !== null ? row[schema.notify] : null) || process.env.NOTIFY_DAYS_BEFORE || '7,3,1,0'
      const notifyDays = notifyDaysRaw
        .toString()
        .split(',')
        .map((d) => parseInt(d.trim()))
        .filter((d) => !isNaN(d))

      const reminder = {
        rowIndex: i + 2,
        tabName,
        source,
        no: schema.no !== null ? (row[schema.no] || '') : '',
        task: (schema.task !== null ? row[schema.task] : null) || 'Unnamed Task',
        deadline: dayjs(deadline),
        rawDeadline: deadline,
        target: schema.target !== null ? (row[schema.target]?.trim() || '') : '',
        notifyDays,
        notes: schema.notes !== null ? (row[schema.notes] || '') : '',
        status,
      }

      reminder.key = getReminderKey(reminder)

      // Apply "done" overrides for auto-import rows (so bot can mark them done even if the source is read-only).
      if (source === 'auto' && overrides?.has(reminder.key)) {
        const overrideStatus = overrides.get(reminder.key)
        if (overrideStatus === 'done' || overrideStatus === 'skip') continue
      }

      reminders.push(reminder)
    }
    return reminders
  } catch (err) {
    console.error(`❌ Error membaca tab "${tabName}":`, err.message)
    return []
  }
}

/**
 * Ambil semua reminder dari kedua tab (auto + manual), gabung & beri nomor urut
 */
async function getReminders() {
  const sheets = await getSheetsClient()
  const autoTab = process.env.SHEET_REMINDER_TAB || 'Reminders'
  const manualTab = process.env.SHEET_MANUAL_TAB || 'MyReminders'

  const { overrides } = await loadOverrides(sheets).catch(() => ({ overrides: null }))

  const [autoReminders, manualReminders] = await Promise.all([
    readTab(sheets, autoTab, 'auto', overrides),
    readTab(sheets, manualTab, 'manual', overrides),
  ])

  // Gabung dan beri nomor urut global
  const all = [...autoReminders, ...manualReminders]
  all.forEach((r, i) => { r.globalNo = i + 1 })
  return all
}

/**
 * Ambil reminder yang due hari ini
 */
async function getDueReminders() {
  const reminders = await getReminders()
  const today = dayjs().startOf('day')
  const dueList = []

  for (const r of reminders) {
    const deadline = r.deadline.startOf('day')
    const daysLeft = deadline.diff(today, 'day')
    if (r.notifyDays.includes(daysLeft)) {
      dueList.push({ ...r, daysLeft })
    }
  }
  return dueList
}

/**
 * Tandai reminder sebagai done
 * - Manual: update kolom status langsung di tab manual
 * - Auto-import: tulis ke tab override (BotOverrides) supaya tetap bisa done dari bot
 */
async function markAsDone(reminder, options = {}) {
  const updatedBy = options.updatedBy || options.actor || ''
  const approvedByName = options.approvedByName || ''

  try {
    const sheets = await getSheetsClient()

    // Prefer direct update when possible.
    try {
      const schema = await getTabSchema(sheets, reminder.tabName)

      // Ensure header exists for approval column (wherever it is on the sheet).
      const ensured = schema.approval !== null ? schema : await ensureTabHeader(sheets, reminder.tabName, 'Approval')

      const statusIdx = ensured.status
      const approvalIdx = ensured.approval
      if (statusIdx === null || approvalIdx === null) throw new Error('Tab schema missing status/approval')

      const statusCol = columnToLetter(statusIdx + 1)
      const approvalCol = columnToLetter(approvalIdx + 1)

      // Update status and approval separately to avoid overwriting columns in between (e.g. PJ).
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${reminder.tabName}!${statusCol}${reminder.rowIndex}:${statusCol}${reminder.rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [['done']] },
      })

      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${reminder.tabName}!${approvalCol}${reminder.rowIndex}:${approvalCol}${reminder.rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[approvedByName]] },
      })
      console.log(`✅ Row ${reminder.rowIndex} di tab "${reminder.tabName}" ditandai done`)
      return { success: true, mode: 'sheet' }
    } catch (err) {
      // If tab is auto-import (IMPORTRANGE), status column is often read-only. Fall back to override tracking.
      if (reminder.source !== 'auto') throw err
    }

    const key = reminder.key || getReminderKey(reminder)
    await upsertOverride(sheets, key, 'done', updatedBy, approvedByName)
    console.log(`✅ Override done disimpan untuk key "${key}"`)
    return { success: true, mode: 'override' }
  } catch (err) {
    console.error('❌ Error update status:', err.message)
    return { success: false, reason: 'error' }
  }
}

/**
 * Tambah reminder baru ke tab manual (MyReminders)
 */
async function addReminder({ task, deadline, target, notifyDays = '7,3,1,0', notes = '' }) {
  try {
    const sheets = await getSheetsClient()
    const manualTab = process.env.SHEET_MANUAL_TAB || 'MyReminders'

    // Auto-increment No berdasarkan jumlah baris di tab manual
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

/**
 * Edit satu field reminder di tab manual
 * Field: task(B), deadline(C), notif(E), catatan(F)
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
    console.log(`✅ Row ${reminder.rowIndex} field ${col} diupdate`)
    return { success: true }
  } catch (err) {
    console.error('❌ Error edit reminder:', err.message)
    return { success: false, reason: 'error' }
  }
}

/**
 * Hapus reminder dari tab manual (set status = skip)
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
    console.log(`🗑️ Row ${reminder.rowIndex} dihapus (skip)`)
    return { success: true }
  } catch (err) {
    console.error('❌ Error hapus reminder:', err.message)
    return { success: false, reason: 'error' }
  }
}

module.exports = {
  getReminders,
  getDueReminders,
  markAsDone,
  addReminder,
  editReminder,
  deleteReminder,
  getReminderKey,
}
