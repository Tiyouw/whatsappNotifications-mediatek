const cron = require('node-cron')
const dayjs = require('dayjs')
const { getReminders, getDueReminders } = require('./sheets')
const { formatReminderMessage, resolveTarget } = require('./reminder')

let schedulerStarted = false

function startScheduler(sock) {
  if (schedulerStarted) return
  schedulerStarted = true

  const cronExpression = process.env.REMINDER_CRON || '0 8 * * *'
  console.log(`⏰ Scheduler aktif | Cron: "${cronExpression}"`)
  console.log(`   (Default: setiap hari jam 08:00 WIB)`)

  cron.schedule(cronExpression, async () => {
    console.log(`\n🔔 [${dayjs().format('DD/MM/YYYY HH:mm')}] Menjalankan cek reminder...`)
    await runReminderCheck(sock)
  }, { timezone: 'Asia/Jakarta' })

  // Weekly summary setiap Senin jam 07:00
  cron.schedule('0 7 * * 1', async () => {
    console.log(`\n📋 [${dayjs().format('DD/MM/YYYY HH:mm')}] Mengirim weekly summary...`)
    await sendWeeklySummary(sock)
  }, { timezone: 'Asia/Jakarta' })

  console.log('   Weekly summary: Setiap Senin jam 07:00 WIB\n')
}

async function runReminderCheck(sock) {
  try {
    const dueReminders = await getDueReminders()

    if (dueReminders.length === 0) {
      console.log('   ✓ Tidak ada reminder untuk dikirim hari ini.')
      return
    }

    console.log(`   📨 Mengirim ${dueReminders.length} reminder...`)

    // Group by target
    const grouped = {}
    for (const r of dueReminders) {
      const target = r.target || process.env.OWNER_NUMBER
      if (!grouped[target]) grouped[target] = []
      grouped[target].push(r)
    }

    for (const [target, reminders] of Object.entries(grouped)) {
      const jid = resolveTarget(target)
      if (!jid) {
        console.warn(`   ⚠️  Target tidak valid: ${target}`)
        continue
      }

      const { text, mentions } = formatReminderMessage(reminders)

      try {
        await sock.sendMessage(jid, { text, mentions })
        console.log(`   ✅ Terkirim ke ${target} (${reminders.length} reminder)`)
        await delay(1500)
      } catch (err) {
        console.error(`   ❌ Gagal kirim ke ${target}:`, err.message)
      }
    }
  } catch (err) {
    console.error('❌ Error saat cek reminder:', err.message)
  }
}

/**
 * Kirim weekly summary — semua reminder aktif dikelompokkan per target
 */
async function sendWeeklySummary(sock, targetJid = null) {
  try {
    const reminders = await getReminders()
    const ownerJid = targetJid || `${process.env.OWNER_NUMBER}@s.whatsapp.net`

    if (reminders.length === 0) {
      await sock.sendMessage(ownerJid, { text: `📋 *Weekly Summary - ${dayjs().format('DD MMM YYYY')}*\n\nTidak ada reminder aktif.` })
      return
    }

    const today = dayjs().startOf('day')
    const lines = reminders.map((r) => {
      const daysLeft = r.deadline.startOf('day').diff(today, 'day')
      const deadlineStr = r.deadline.format('DD MMM YYYY')
      const statusEmoji = daysLeft < 0 ? '🔴' : daysLeft === 0 ? '🔥' : daysLeft <= 3 ? '⚠️' : '📌'
      const daysText = daysLeft < 0
        ? `(telat ${Math.abs(daysLeft)} hari)`
        : daysLeft === 0 ? '(Hari ini!)'
        : `(${daysLeft} hari lagi)`
      const targetLabel = r.target?.includes('@g.us') ? '👥 Grup' : '👤 Pribadi'

      return `${statusEmoji} *[${r.globalNo}] ${r.task}*\n   📅 ${deadlineStr} ${daysText}\n   ${targetLabel}${r.notes ? ` • ${r.notes}` : ''}`
    })

    const message =
      `📋 *Weekly Summary - ${dayjs().format('DD MMM YYYY')}*\n` +
      `Total: ${reminders.length} reminder aktif\n` +
      `${'─'.repeat(28)}\n\n` +
      lines.join('\n\n') +
      `\n\n_!cek untuk detail • !done [no] untuk selesaikan_`

    await sock.sendMessage(ownerJid, { text: message })
    console.log('   ✅ Weekly summary terkirim')
  } catch (err) {
    console.error('❌ Gagal kirim weekly summary:', err.message)
  }
}

async function triggerManualCheck(sock) {
  return runReminderCheck(sock)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = { startScheduler, triggerManualCheck, runReminderCheck, sendWeeklySummary }