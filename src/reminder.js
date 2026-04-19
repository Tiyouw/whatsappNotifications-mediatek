const dayjs = require('dayjs')

/**
 * Format pesan reminder untuk dikirim via WhatsApp
 * Menyertakan nomor reminder agar bisa langsung !done [no]
 *
 * @param {Array} reminders
 * @returns {{ text: string, mentions: string[] }}
 */
function formatReminderMessage(reminders) {
  const today = dayjs().format('DD MMM YYYY')

  let msg = `🤖 *Reo'sBot Reminder*\n`
  msg += `📅 ${today}\n`
  msg += `${'─'.repeat(28)}\n\n`

  const allMentions = []

  for (const r of reminders) {
    const urgencyEmoji = getUrgencyEmoji(r.daysLeft)
    const urgencyText = getUrgencyText(r.daysLeft)
    const deadlineFormatted = r.deadline.format('DD MMM YYYY')
    const { text: notesText, mentions } = parseMentions(r.notes || '')
    allMentions.push(...mentions)

    msg += `${urgencyEmoji} *[${r.globalNo}] ${r.task}*\n`
    msg += `   ⏳ ${deadlineFormatted} — ${urgencyText}\n`
    if (notesText) msg += `   📝 ${notesText}\n`
    msg += '\n'
  }

  msg += `_!done [no] selesai  •  !cek semua reminder_`

  return { text: msg, mentions: [...new Set(allMentions)] }
}

/**
 * Format satu reminder untuk !hari (dengan nomor)
 */
function formatSingleReminder(r) {
  const today = dayjs().startOf('day')
  const daysLeft = r.daysLeft !== undefined
    ? r.daysLeft
    : r.deadline.startOf('day').diff(today, 'day')
  const urgencyEmoji = getUrgencyEmoji(daysLeft)
  const urgencyText = getUrgencyText(daysLeft)
  const { text: notesText } = parseMentions(r.notes || '')

  return (
    `${urgencyEmoji} *[${r.globalNo}] ${r.task}*\n` +
    `📅 Deadline: ${r.deadline.format('DD MMM YYYY')}\n` +
    `⏳ ${urgencyText}\n` +
    (notesText ? `📝 ${notesText}\n` : '') +
    `🔔 Notif di H-: ${r.notifyDays.join(', ')}`
  )
}

/**
 * Parse mention @628xxx dari teks catatan
 */
function parseMentions(notes) {
  const mentions = []
  const text = notes.replace(/@(\d{8,15})/g, (match, number) => {
    const normalized = number.startsWith('0') ? '62' + number.slice(1) : number
    const jid = `${normalized}@s.whatsapp.net`
    mentions.push(jid)
    return `@${normalized}`
  })
  return { text, mentions }
}

/**
 * Resolve target string ke WhatsApp JID
 */
function resolveTarget(target) {
  if (!target) return `${process.env.OWNER_NUMBER}@s.whatsapp.net`
  if (target.includes('@g.us')) return target
  if (target.includes('@s.whatsapp.net')) return target

  const cleaned = target.replace(/\D/g, '')
  if (cleaned.length >= 10) {
    const normalized = cleaned.startsWith('0') ? '62' + cleaned.slice(1) : cleaned
    return `${normalized}@s.whatsapp.net`
  }

  console.warn(`⚠️  Tidak bisa resolve target: "${target}"`)
  return null
}

function getUrgencyEmoji(daysLeft) {
  if (daysLeft < 0) return '🔴'
  if (daysLeft === 0) return '🔥'
  if (daysLeft === 1) return '❗'
  if (daysLeft <= 3) return '⚠️'
  if (daysLeft <= 7) return '📌'
  return '📎'
}

function getUrgencyText(daysLeft) {
  if (daysLeft < 0) return `Telat ${Math.abs(daysLeft)} hari!`
  if (daysLeft === 0) return 'Hari ini!'
  if (daysLeft === 1) return 'Besok!'
  if (daysLeft <= 3) return `${daysLeft} hari lagi`
  if (daysLeft <= 7) return `${daysLeft} hari lagi`
  return `${daysLeft} hari lagi`
}

module.exports = {
  formatReminderMessage,
  formatSingleReminder,
  parseMentions,
  resolveTarget,
  getUrgencyEmoji,
  getUrgencyText,
}