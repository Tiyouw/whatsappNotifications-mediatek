# Graph Report - wa-reminder-bot  (2026-05-20)

## Corpus Check
- 25 files · ~52,770 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 312 nodes · 485 edges · 20 communities (17 shown, 3 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]

## God Nodes (most connected - your core abstractions)
1. `handleCommand()` - 21 edges
2. `Fly.io Deployment Runbook` - 17 edges
3. `now()` - 14 edges
4. `🤖 Reo'sBot — WhatsApp Reminder Bot` - 14 edges
5. `Dashboard And Deploy Context` - 11 edges
6. `handleSetDamn()` - 10 edges
7. `log()` - 9 edges
8. `handleStickerCommand()` - 9 edges
9. `10. Verify there is no QR in the logs` - 8 edges
10. `loadReminders()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `serializeReminder()` --calls--> `now()`  [EXTRACTED]
  src/dashboardServer.js → src/time.js
- `handleCommand()` --calls--> `now()`  [EXTRACTED]
  src/commandHandler.js → src/time.js
- `handleCommand()` --calls--> `triggerManualCheck()`  [EXTRACTED]
  src/commandHandler.js → src/scheduler.js
- `handleCommand()` --calls--> `sendWeeklySummary()`  [EXTRACTED]
  src/commandHandler.js → src/scheduler.js
- `handleSetDamn()` --calls--> `getMediaType()`  [EXTRACTED]
  src/commandHandler.js → src/stickerHandler.js

## Communities (20 total, 3 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.1
Nodes (40): buildQuotedMsg(), COMMAND_ALIASES, {
  convertImageToSticker,
  convertVideoToSticker,
  getMediaBuffer,
  getMediaType,
  getMimeType,
}, dayjs, displayNameFromJid(), filterByContext(), { formatSingleReminder, parseMentions, resolveTarget }, getMessageText() (+32 more)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (35): 0. Prerequisites, 10. Verify there is no QR in the logs, 11. Cost expectations, 12. Session portability caveat, 13. Day-2 operations cheatsheet, 14. Scaling memory, 1. Install flyctl and sign in, 2. Create the app (+27 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (32): 🔒 Akses & Keamanan, ⚠️ Catatan Overdue, code:powershell (flyctl secrets set DASHBOARD_TOKEN="use-a-long-random-passwo), code:block11 (@6282132341102 tolong segera kerjakan!), code:bash (npm install -g pm2), code:bash (pm2 status          # cek status), code:powershell (npm run service:uninstall), code:block15 (wa-reminder-bot/) (+24 more)

### Community 3 - "Community 3"
Cohesion: 0.09
Nodes (26): handleStickerCommand(), startDashboardServer(), convertImageToSticker(), convertVideoToSticker(), ffmpeg, ffmpegPath, getMediaBuffer(), getMediaCaption() (+18 more)

### Community 4 - "Community 4"
Cohesion: 0.14
Nodes (25): dayjs, formatReminderMessage(), formatSingleReminder(), formatSingleReminderMessage(), getUrgencyEmoji(), getUrgencyText(), { now }, parseMentions() (+17 more)

### Community 5 - "Community 5"
Cohesion: 0.18
Nodes (26): api(), bindEvents(), boot(), describe(), els, filteredReminders(), getTotalPages(), loadConfig() (+18 more)

### Community 6 - "Community 6"
Cohesion: 0.09
Nodes (16): { convertImageToSticker, convertVideoToSticker }, crypto, DASHBOARD_PORT, fs, { getReminders, markAsDone, addReminder, deleteReminder }, http, { now }, path (+8 more)

### Community 7 - "Community 7"
Cohesion: 0.1
Nodes (20): Built-In Dashboard, code:text (https://reo-on-cavern.fly.dev/), code:js (getReminders({ includeInactive: true })), code:powershell (flyctl ips allocate-v4 --shared --app reo-on-cavern), code:powershell (flyctl proxy 3001:3000 --app reo-on-cavern), code:text (http://127.0.0.1:3001/), code:powershell (flyctl secrets set DASHBOARD_TOKEN="new-token-here" --app re), code:powershell (flyctl deploy --app reo-on-cavern) (+12 more)

### Community 8 - "Community 8"
Cohesion: 0.17
Nodes (12): 1. Install Node.js, 2. Install ffmpeg, 3. Install dependencies, 4. Setup Google Sheets API, 5. Konfigurasi `.env`, 6. Jalankan Bot, code:bash (npm install), code:block2 (https://docs.google.com/spreadsheets/d/[SPREADSHEET_ID]/edit) (+4 more)

### Community 9 - "Community 9"
Cohesion: 0.22
Nodes (5): Reminder, FilterTabsProps, getUrgency(), ReminderCard(), ReminderCardProps

### Community 10 - "Community 10"
Cohesion: 0.29
Nodes (7): COL, getReminders(), getSheetsClient(), isValidRow(), MONTH_NAMES, readTab(), Reminder

### Community 11 - "Community 11"
Cohesion: 0.31
Nodes (8): fs, get(), load(), MAP_PATH, path, remove(), save(), set()

### Community 12 - "Community 12"
Cohesion: 0.22
Nodes (9): 5. SEED THE VOLUME (before first deploy), code:powershell (flyctl ssh console --app $APP --command "sh -lc 'cd /data &&), code:powershell (# Launch a short-lived machine with the volume attached. `al), code:powershell (flyctl ssh sftp shell --app $APP), code:powershell (flyctl ssh console --app $APP --command "sh -lc 'cd /data &&), code:block9 (/data/), Option 1 — SFTP via a throwaway machine (recommended), Option 2 — Seeder Dockerfile (alternative, not recommended for session data) (+1 more)

### Community 13 - "Community 13"
Cohesion: 0.4
Nodes (3): inter, metadata, viewport

## Knowledge Gaps
- **140 isolated node(s):** `{
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
}`, `{ Boom }`, `path`, `pino`, `qrcode` (+135 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Fly.io Deployment Runbook` connect `Community 1` to `Community 12`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `🤖 Reo'sBot — WhatsApp Reminder Bot` connect `Community 2` to `Community 8`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `🚀 Setup Awal` connect `Community 8` to `Community 2`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **What connects `{
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
}`, `{ Boom }`, `path` to the rest of the system?**
  _140 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._