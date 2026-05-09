/**
 * reactionMap.js
 *
 * Persists a mapping of WhatsApp messageId → reminderNo so that
 * when a user reacts ✅ to a reminder message, the bot knows
 * exactly which reminder to mark as done.
 *
 * Storage: data/reactionMap.json  (auto-created if missing)
 * In-memory cache is kept in sync with the file.
 *
 * Map structure (JSON):
 * {
 *   "<messageId>": {
 *     "reminderNo": 3,
 *     "targetJid": "628xxx@g.us",   ← where the message was sent
 *     "savedAt": "2026-05-09T08:00:00.000Z"
 *   },
 *   ...
 * }
 *
 * TTL: entries older than MAX_AGE_DAYS are pruned on every write
 * so the file never grows unbounded.
 */

const fs = require('fs')
const path = require('path')

const MAP_PATH = path.resolve(__dirname, '..', 'data', 'reactionMap.json')
const MAX_AGE_DAYS = 14   // keep entries for 14 days max

// ── In-memory cache ────────────────────────────────────────────────
let cache = null

function load() {
  if (cache) return cache
  try {
    if (fs.existsSync(MAP_PATH)) {
      cache = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'))
    } else {
      cache = {}
    }
  } catch {
    console.warn('⚠️  reactionMap: failed to read file, starting fresh')
    cache = {}
  }
  return cache
}

function save(map) {
  // Prune entries older than MAX_AGE_DAYS before writing
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  const pruned = {}
  for (const [id, entry] of Object.entries(map)) {
    if (new Date(entry.savedAt).getTime() >= cutoff) {
      pruned[id] = entry
    }
  }
  cache = pruned
  try {
    // Ensure data/ directory exists
    fs.mkdirSync(path.dirname(MAP_PATH), { recursive: true })
    fs.writeFileSync(MAP_PATH, JSON.stringify(pruned, null, 2), 'utf8')
  } catch (err) {
    console.error('❌ reactionMap: failed to write file:', err.message)
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Store a messageId → reminder mapping.
 * @param {string} messageId  - msg.key.id from Baileys sendMessage response
 * @param {number} reminderNo - r.globalNo
 * @param {string} targetJid  - JID the message was sent to
 */
function set(messageId, reminderNo, targetJid) {
  const map = load()
  map[messageId] = {
    reminderNo,
    targetJid,
    savedAt: new Date().toISOString(),
  }
  save(map)
}

/**
 * Look up a messageId.
 * @param {string} messageId
 * @returns {{ reminderNo: number, targetJid: string } | null}
 */
function get(messageId) {
  const map = load()
  return map[messageId] || null
}

/**
 * Remove a mapping after it has been acted on (optional cleanup).
 * @param {string} messageId
 */
function remove(messageId) {
  const map = load()
  if (map[messageId]) {
    delete map[messageId]
    save(map)
  }
}

module.exports = { set, get, remove }
