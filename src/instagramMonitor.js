/**
 * instagramMonitor.js
 *
 * Polls the Instagram Graph API for new posts/reels and sends a WhatsApp
 * notification when new content is detected.
 *
 * State: data/igState.json (auto-created if missing)
 * Env vars: IG_MONITOR_ENABLED, IG_USER_ID, IG_ACCESS_TOKEN, IG_CHECK_CRON,
 *           IG_NOTIFY_TARGET, IG_CONTENT_TYPES, IG_STATE_PATH, IG_TOKEN_EXPIRES_AT
 */

const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

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
  return { lastPostId: null, lastChecked: null, enabled: true };
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

function getContentTypeFilter() {
  const raw = (process.env.IG_CONTENT_TYPES || "post").toLowerCase();
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Map IG media_type to our content category.
 * IMAGE and CAROUSEL_ALBUM = "post", VIDEO = "reel"
 */
function mediaTypeToCategory(mediaType) {
  if (mediaType === "VIDEO") return "reel";
  return "post"; // IMAGE, CAROUSEL_ALBUM
}

function isMonitorEnabled() {
  const envEnabled = (process.env.IG_MONITOR_ENABLED || "true").toLowerCase() !== "false";
  const state = loadState();
  return envEnabled && state.enabled;
}

function formatNotification(post) {
  const isReel = post.media_type === "VIDEO";
  const emoji = isReel ? "\uD83C\uDFAC" : "\uD83D\uDCF8"; // 🎬 or 📸
  const typeLabel = isReel ? "Reel baru" : "Post baru";
  const caption = post.caption ? `"${post.caption}"` : "";
  const permalink = post.permalink || "";

  let text = `${emoji} ${typeLabel} di Instagram!\n`;
  if (caption) {
    text += `\n${caption}\n`;
  }
  if (permalink) {
    text += `\n\uD83D\uDD17 ${permalink}\n`;
  }
  text += `\nJangan lupa like ya! \u2764\uFE0F`;
  return text;
}

// ── Instagram API ──────────────────────────────────────────────────────
async function fetchRecentMedia() {
  const userId = process.env.IG_USER_ID;
  const token = process.env.IG_ACCESS_TOKEN;

  if (!userId || !token) {
    console.warn("⚠️  instagramMonitor: IG_USER_ID or IG_ACCESS_TOKEN not set");
    return null;
  }

  const url =
    `https://graph.instagram.com/${userId}/media` +
    `?fields=id,caption,media_type,permalink,timestamp` +
    `&access_token=${token}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      // Token expired or invalid
      if (data.error.code === 190) {
        return { error: "token_expired", message: data.error.message };
      }
      return { error: "api_error", message: data.error.message };
    }

    return { posts: data.data || [] };
  } catch (err) {
    console.error("❌ instagramMonitor: fetch failed:", err.message);
    return { error: "network_error", message: err.message };
  }
}

// ── Token expiry check ─────────────────────────────────────────────────
function checkTokenExpiry(sock) {
  const expiresAt = process.env.IG_TOKEN_EXPIRES_AT;
  if (!expiresAt) return;

  const expiryDate = new Date(expiresAt);
  if (isNaN(expiryDate.getTime())) return;

  const now = new Date();
  const daysLeft = (expiryDate - now) / (1000 * 60 * 60 * 24);

  if (daysLeft <= 7 && daysLeft > 0) {
    const ownerJid = `${process.env.OWNER_NUMBER}@s.whatsapp.net`;
    const daysRounded = Math.ceil(daysLeft);
    sock
      .sendMessage(ownerJid, {
        text:
          `\u26A0\uFE0F *Instagram Token Expiry Warning*\n\n` +
          `Token akan expired dalam ${daysRounded} hari (${expiryDate.toISOString().split("T")[0]}).\n` +
          `Segera refresh token di Facebook Developer Console.`,
      })
      .catch((err) => {
        console.error("❌ instagramMonitor: failed to send token warning:", err.message);
      });
  }
}

// ── Core check logic ───────────────────────────────────────────────────
async function performCheck(sock) {
  if (!isMonitorEnabled()) {
    return { checked: false, reason: "disabled" };
  }

  const result = await fetchRecentMedia();
  if (!result) {
    return { checked: false, reason: "missing_config" };
  }

  const state = loadState();
  state.lastChecked = new Date().toISOString();

  if (result.error) {
    // Notify owner about token issues
    if (result.error === "token_expired") {
      const ownerJid = `${process.env.OWNER_NUMBER}@s.whatsapp.net`;
      await sock
        .sendMessage(ownerJid, {
          text:
            `\u26A0\uFE0F *Instagram Token Error*\n\n` +
            `Token expired atau invalid: ${result.message}\n` +
            `Segera refresh token di Facebook Developer Console.`,
        })
        .catch(() => {});
    }
    saveState(state);
    return { checked: true, newPost: false, error: result.error };
  }

  const { posts } = result;
  if (!posts || posts.length === 0) {
    saveState(state);
    return { checked: true, newPost: false };
  }

  // Filter by content type
  const allowedTypes = getContentTypeFilter();
  const filtered = posts.filter((p) => allowedTypes.includes(mediaTypeToCategory(p.media_type)));

  if (filtered.length === 0) {
    saveState(state);
    return { checked: true, newPost: false };
  }

  const latestPost = filtered[0];

  // Compare with stored last post ID
  if (state.lastPostId === latestPost.id) {
    saveState(state);
    return { checked: true, newPost: false };
  }

  // New post detected!
  const isFirstRun = state.lastPostId === null;
  state.lastPostId = latestPost.id;
  saveState(state);

  // On first run, just store the ID without sending notification
  if (isFirstRun) {
    console.log("📸 instagramMonitor: first run, stored current post ID");
    return { checked: true, newPost: false, firstRun: true };
  }

  // Send notification
  const targetJid = resolveNotifyTarget();
  const text = formatNotification(latestPost);

  try {
    await sock.sendMessage(targetJid, { text });
    console.log(`📸 instagramMonitor: new post notified → ${targetJid}`);
  } catch (err) {
    console.error("❌ instagramMonitor: failed to send notification:", err.message);
  }

  return { checked: true, newPost: true, post: latestPost };
}

// ── Scheduled monitor ──────────────────────────────────────────────────
let cronTask = null;

function startInstagramMonitor(sock) {
  const cronExpr = process.env.IG_CHECK_CRON || "*/5 * * * *";

  if ((process.env.IG_MONITOR_ENABLED || "true").toLowerCase() === "false") {
    console.log("📸 instagramMonitor: disabled via IG_MONITOR_ENABLED=false");
    return;
  }

  if (!process.env.IG_USER_ID || !process.env.IG_ACCESS_TOKEN) {
    console.log("📸 instagramMonitor: skipped (IG_USER_ID or IG_ACCESS_TOKEN not set)");
    return;
  }

  console.log(`📸 instagramMonitor: started (cron: ${cronExpr})`);

  cronTask = cron.schedule(
    cronExpr,
    async () => {
      try {
        await performCheck(sock);
        checkTokenExpiry(sock);
      } catch (err) {
        console.error("❌ instagramMonitor: cron error:", err.message);
      }
    },
    { timezone: "Asia/Jakarta" }
  );
}

// ── Public API ─────────────────────────────────────────────────────────
async function checkInstagramNow(sock) {
  return await performCheck(sock);
}

function getIgStatus() {
  const state = loadState();
  const envEnabled = (process.env.IG_MONITOR_ENABLED || "true").toLowerCase() !== "false";
  return {
    enabled: envEnabled && state.enabled,
    envEnabled,
    stateEnabled: state.enabled,
    lastPostId: state.lastPostId,
    lastChecked: state.lastChecked,
    cronExpr: process.env.IG_CHECK_CRON || "*/5 * * * *",
    userId: process.env.IG_USER_ID || null,
    notifyTarget: process.env.IG_NOTIFY_TARGET || "owner",
    contentTypes: process.env.IG_CONTENT_TYPES || "post",
  };
}

function setIgEnabled(enabled) {
  const state = loadState();
  state.enabled = Boolean(enabled);
  saveState(state);
  return state.enabled;
}

module.exports = { startInstagramMonitor, checkInstagramNow, getIgStatus, setIgEnabled };
