/**
 * msgCache.js
 *
 * In-memory message cache shared between index.js (writer) and the rest
 * of the codebase (readers). Used for two purposes:
 *
 *   1. Baileys' getMessage callback — required so the lib can re-deliver
 *      decryption keys for retries. Stores recently-seen incoming messages.
 *
 *   2. Content-based reaction resolution — when the messages.reaction
 *      event reports a message ID that doesn't appear in reactionMap
 *      (WhatsApp can use different internal IDs in LID-enabled groups),
 *      handleReaction can fall back to reading the cached message text
 *      and parsing the "[N]" reminder number out of it.
 *
 * The cache is bounded (FIFO eviction) to keep memory predictable.
 */

const MAX_ENTRIES = 1000;
const cache = new Map();

/**
 * Store a Baileys message keyed by its message ID. No-op if the message
 * has no ID.
 */
function set(msg) {
  const id = msg?.key?.id;
  if (!id) return;
  cache.set(id, msg);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/**
 * Retrieve a cached message by its ID, or undefined if not present.
 */
function get(id) {
  if (!id) return undefined;
  return cache.get(id);
}

/**
 * Number of entries currently held. Useful for diagnostics only.
 */
function size() {
  return cache.size;
}

module.exports = { set, get, size };
