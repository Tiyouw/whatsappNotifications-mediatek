/**
 * instagramMonitor.js
 *
 * Receives Instagram post notifications via IFTTT webhook and sends a
 * WhatsApp notification to the configured target.
 *
 * State: data/igState.json (auto-created if missing)
 * Env vars: IG_MONITOR_ENABLED, IG_NOTIFY_TARGET, IG_STATE_PATH, IG_WEBHOOK_SECRET
 */

const fs = require("fs");
const path = require("path");

// ── Path resolution (same pattern as reactionMap.js) ───────────────────
function resolveStatePath() {
  const raw = process.env.IG_STATE_PATH;
  if (process.env.NODE_ENV === "production") {
    if (!raw || !path.isAbsolute(raw)) {
      const msg =
        "❌ FATAL: IG_STATE_PATH must be set to an absolute path when " +
        `NODE_ENV=production (got ${JSON.stringify(raw)}). Check fly.toml [env] ` +
        "and run `flyctl secrets list` to confirm no secret is shadowing it.";
      console.error(msg);
      process.exit(1);
    }
    return raw;
  }
  if (!raw) return path.resolve(__dirname, "..", "data", "igState.json");
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
    console.warn("⚠️  instagramMonitor: failed to read state, starting fresh");
  }
  return { lastNotificationSent: null, enabled: true };
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("❌ instagramMonitor: failed to write state:", err.message);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────
function resolveNotifyTarget() {
  const target = process.env.IG_NOTIFY_TARGET || "owner";
  if (target === "owner") {
    return `${process.env.OWNER_NUMBER}@s.whatsapp.net`;
  }
  return target;
}

function isMonitorEnabled() {
  const envEnabled = (process.env.IG_MONITOR_ENABLED || "true").toLowerCase() !== "false";
  const state = loadState();
  return envEnabled && state.enabled;
}

function formatNotification(postData) {
  const caption = postData.caption ? `"${postData.caption}"` : "";
  const url = postData.url || postData.source_url || "";

  let text = `\uD83D\uDCF8 Post baru di Instagram!\n`;
  if (caption) {
    text += `\n${caption}\n`;
  }
  if (url) {
    text += `\n\uD83D\uDD17 ${url}\n`;
  }
  text += `\nJangan lupa like ya! \u2764\uFE0F`;
  return text;
}

// ── Stored sock reference ──────────────────────────────────────────────
let _sock = null;

// ── Webhook handler ────────────────────────────────────────────────────
/**
 * Handle an incoming webhook POST from IFTTT with Instagram post data.
 * @param {object} sock - Baileys WhatsApp socket (or null to use stored ref)
 * @param {object} postData - { caption, url, source_url, created_at }
 * @returns {{ success: boolean, reason?: string }}
 */
async function handleWebhookPost(sock, postData) {
  const activeSock = sock || _sock;
  if (!activeSock) {
    return { success: false, reason: "WhatsApp socket not available" };
  }

  if (!isMonitorEnabled()) {
    return { success: false, reason: "monitor_disabled" };
  }

  const targetJid = resolveNotifyTarget();
  const text = formatNotification(postData);

  try {
    await activeSock.sendMessage(targetJid, { text });
    console.log(`📸 instagramMonitor: webhook notification sent → ${targetJid}`);

    // Update state
    const state = loadState();
    state.lastNotificationSent = new Date().toISOString();
    state.lastPostUrl = postData.url || postData.source_url || null;
    state.lastCaption = postData.caption || null;
    saveState(state);

    return { success: true };
  } catch (err) {
    console.error("❌ instagramMonitor: failed to send notification:", err.message);
    return { success: false, reason: err.message };
  }
}

// ── Scheduled monitor (webhook mode - no cron needed) ──────────────────
function startInstagramMonitor(sock) {
  _sock = sock;

  if ((process.env.IG_MONITOR_ENABLED || "true").toLowerCase() === "false") {
    console.log("📸 instagramMonitor: disabled via IG_MONITOR_ENABLED=false");
    return;
  }

  console.log("📸 instagramMonitor: started in webhook mode (IFTTT)");
  console.log("   Waiting for POST /webhook/instagram from IFTTT...");
}

// ── Public API ─────────────────────────────────────────────────────────
function getIgStatus() {
  const state = loadState();
  const envEnabled = (process.env.IG_MONITOR_ENABLED || "true").toLowerCase() !== "false";
  return {
    enabled: envEnabled && state.enabled,
    envEnabled,
    stateEnabled: state.enabled,
    lastNotificationSent: state.lastNotificationSent || null,
    lastPostUrl: state.lastPostUrl || null,
    lastCaption: state.lastCaption || null,
    notifyTarget: process.env.IG_NOTIFY_TARGET || "owner",
    mode: "webhook (IFTTT)",
  };
}

function setIgEnabled(enabled) {
  const state = loadState();
  state.enabled = Boolean(enabled);
  saveState(state);
  return state.enabled;
}

module.exports = { startInstagramMonitor, handleWebhookPost, getIgStatus, setIgEnabled };
