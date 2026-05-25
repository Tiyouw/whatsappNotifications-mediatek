/**
 * instagramMonitor.js
 *
 * Monitors a public Instagram profile for new posts. Uses a layered approach:
 *
 * 1. PRIMARY: Instagram Graph API (requires IG_USER_ID + IG_ACCESS_TOKEN)
 * 2. Fallback: Instagram web_profile_info API endpoint (scraping)
 * 3. Fallback: ?__a=1&__d=dis endpoint (scraping)
 * 4. Last resort: HTML scraping for shortcode patterns
 *
 * The Graph API is preferred because it is reliable from datacenter IPs
 * (Fly.io etc.) where direct scraping gets 429 rate-limited.
 *
 * Uses node-cron for periodic polling with a random delay to avoid
 * exact-timing detection on the scraping fallbacks.
 *
 * State: data/igState.json (auto-created if missing)
 * Env vars: IG_MONITOR_ENABLED, IG_USERNAME, IG_USER_ID, IG_ACCESS_TOKEN,
 *           IG_TOKEN_EXPIRES_AT, IG_CHECK_CRON, IG_NOTIFY_TARGET,
 *           IG_WEBHOOK_SECRET, IG_STATE_PATH
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
  return {
    lastShortcode: null,
    lastChecked: null,
    lastNotificationSent: null,
    enabled: true,
    consecutiveErrors: 0,
    lastMethod: null,
    lastExpiryWarningSent: null,
  };
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

/**
 * Common request headers to mimic a browser and avoid immediate blocking.
 */
function getBrowserHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity",
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };
}

// ── Instagram Graph API (PRIMARY method) ───────────────────────────────

/**
 * Fetch the latest post via Instagram Graph API.
 * Requires IG_USER_ID and IG_ACCESS_TOKEN env vars.
 * @param {number} limit - Number of posts to fetch (default 1, max 25)
 * Returns { shortcode, caption, timestamp, permalink } or null.
 */
async function fetchViaGraphApi(limit = 1) {
  const userId = process.env.IG_USER_ID;
  const accessToken = process.env.IG_ACCESS_TOKEN;

  if (!userId || !accessToken) return null;

  const fetchLimit = Math.min(Math.max(limit, 1), 25);
  const url =
    `https://graph.instagram.com/${userId}/media` +
    `?fields=id,caption,media_type,permalink,timestamp&limit=${fetchLimit}` +
    `&access_token=${accessToken}`;

  const response = await fetch(url);

  if (!response.ok) {
    const status = response.status;
    let errorBody = null;
    try {
      errorBody = await response.json();
    } catch {
      // body not JSON
    }

    const errorCode = errorBody?.error?.code;
    const errorMsg = errorBody?.error?.message || `HTTP ${status}`;

    // 401 or error code 190 = token expired/invalid
    if (status === 401 || errorCode === 190) {
      console.error(`📸 instagramMonitor: Graph API token expired/invalid: ${errorMsg}`);
      await notifyTokenExpired(errorMsg);
      throw new Error(`graph_api_token_expired: ${errorMsg}`);
    }

    // 429 = rate limited
    if (status === 429) {
      console.warn(`📸 instagramMonitor: Graph API rate limited, will retry next cycle`);
      throw new Error("graph_api_rate_limited");
    }

    throw new Error(`graph_api_error: ${errorMsg}`);
  }

  const data = await response.json();
  const posts = data?.data;

  if (!posts || posts.length === 0) return null;

  // Return all fetched posts as an array of normalized objects
  const results = posts.map((post) => {
    const shortcode = extractShortcodeFromPermalink(post.permalink);
    return {
      shortcode: shortcode || post.id,
      caption: post.caption || "",
      timestamp: post.timestamp ? Math.floor(new Date(post.timestamp).getTime() / 1000) : null,
      permalink: post.permalink,
      mediaType: post.media_type,
      method: "graph_api",
    };
  });

  // For backward compat: if limit=1, return single object
  if (fetchLimit === 1) return results[0];
  return results;
}

/**
 * Extract shortcode from an Instagram permalink URL.
 * e.g. https://www.instagram.com/p/DYnzUOJEwPJ/ -> DYnzUOJEwPJ
 *      https://www.instagram.com/reel/ABC123/ -> ABC123
 */
function extractShortcodeFromPermalink(permalink) {
  if (!permalink) return null;
  const match = permalink.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[2] : null;
}

/**
 * Notify owner that the Graph API token has expired or is invalid.
 */
async function notifyTokenExpired(errorMsg) {
  if (!_sock) return;
  const ownerNum = process.env.OWNER_NUMBER;
  if (!ownerNum) return;

  const targetJid = `${ownerNum}@s.whatsapp.net`;
  try {
    await _sock.sendMessage(targetJid, {
      text:
        `\u26A0\uFE0F Instagram Graph API token expired!\n\n` +
        `Error: ${errorMsg}\n\n` +
        `Generate a new long-lived token and update IG_ACCESS_TOKEN.\n` +
        `Bot will fall back to scraping in the meantime.`,
    });
  } catch {
    // Ignore send failure
  }
}

/**
 * Check if the Graph API token is close to expiry and warn the owner.
 * Uses IG_TOKEN_EXPIRES_AT env var (ISO date string like "2025-07-23").
 * Only sends a warning once every 24 hours (debounced via state).
 */
async function checkTokenExpiry() {
  if (!_sock) return;

  const expiresAt = process.env.IG_TOKEN_EXPIRES_AT;
  if (!expiresAt) return;

  const expiryDate = new Date(expiresAt);
  if (isNaN(expiryDate.getTime())) return;

  const now = new Date();
  const daysUntilExpiry = (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  // Only warn if within 7 days of expiry
  if (daysUntilExpiry > 7) return;

  // Debounce: only send once every 24 hours
  const state = loadState();
  if (state.lastExpiryWarningSent) {
    const lastSent = new Date(state.lastExpiryWarningSent);
    const hoursSinceLastWarning = (now.getTime() - lastSent.getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastWarning < 24) return;
  }

  const ownerNum = process.env.OWNER_NUMBER;
  if (!ownerNum) return;

  const targetJid = `${ownerNum}@s.whatsapp.net`;
  const daysText = daysUntilExpiry <= 0
    ? "sudah expired"
    : `expires in ${Math.ceil(daysUntilExpiry)} day(s)`;

  try {
    await _sock.sendMessage(targetJid, {
      text:
        `\u26A0\uFE0F Instagram Graph API token ${daysText}!\n\n` +
        `Expiry date: ${expiresAt}\n` +
        `Generate a new long-lived token and update IG_ACCESS_TOKEN + IG_TOKEN_EXPIRES_AT.`,
    });

    // Update debounce timestamp
    state.lastExpiryWarningSent = now.toISOString();
    saveState(state);
  } catch {
    // Ignore send failure
  }
}

// ── Instagram scraping approaches ──────────────────────────────────────

/**
 * Attempt 1: Use Instagram's web_profile_info API endpoint.
 * Requires X-IG-App-ID header (public web app ID, same for everyone).
 */
async function fetchViaWebProfileInfo(username) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const headers = {
    ...getBrowserHeaders(),
    "X-IG-App-ID": "936619743392459",
    "X-Requested-With": "XMLHttpRequest",
  };

  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`web_profile_info returned ${response.status}`);
  }

  const data = await response.json();
  const edges =
    data?.data?.user?.edge_owner_to_timeline_media?.edges ||
    data?.graphql?.user?.edge_owner_to_timeline_media?.edges ||
    [];

  if (edges.length === 0) return null;

  const latestNode = edges[0].node;
  return {
    shortcode: latestNode.shortcode,
    caption: latestNode.edge_media_to_caption?.edges?.[0]?.node?.text || "",
    timestamp: latestNode.taken_at_timestamp,
  };
}

/**
 * Attempt 2: Use the ?__a=1&__d=dis endpoint.
 */
async function fetchViaJsonEndpoint(username) {
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`;
  const headers = {
    ...getBrowserHeaders(),
    "X-IG-App-ID": "936619743392459",
    "X-Requested-With": "XMLHttpRequest",
  };

  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`__a=1 endpoint returned ${response.status}`);
  }

  const data = await response.json();
  const edges =
    data?.graphql?.user?.edge_owner_to_timeline_media?.edges ||
    data?.data?.user?.edge_owner_to_timeline_media?.edges ||
    [];

  if (edges.length === 0) return null;

  const latestNode = edges[0].node;
  return {
    shortcode: latestNode.shortcode,
    caption: latestNode.edge_media_to_caption?.edges?.[0]?.node?.text || "",
    timestamp: latestNode.taken_at_timestamp,
  };
}

/**
 * Attempt 3: Fetch profile page HTML and look for shortcode patterns.
 * This is a last resort -- Instagram may not include post data in the HTML
 * for logged-out users, but we try to find embedded JSON or shortcode strings.
 */
async function fetchViaHtmlScraping(username) {
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  const headers = getBrowserHeaders();

  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTML fetch returned ${response.status}`);
  }

  const html = await response.text();

  // Check if we got a login page or rate limit
  if (html.includes("loginForm") || html.includes("Login") && html.length < 5000) {
    throw new Error("Instagram returned login page (possible rate limit)");
  }

  // Try to find embedded JSON (window._sharedData or window.__additionalDataLoaded)
  const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.+?});<\/script>/s);
  if (sharedDataMatch) {
    try {
      const data = JSON.parse(sharedDataMatch[1]);
      const user = data?.entry_data?.ProfilePage?.[0]?.graphql?.user;
      const edges = user?.edge_owner_to_timeline_media?.edges || [];
      if (edges.length > 0) {
        const latestNode = edges[0].node;
        return {
          shortcode: latestNode.shortcode,
          caption: latestNode.edge_media_to_caption?.edges?.[0]?.node?.text || "",
          timestamp: latestNode.taken_at_timestamp,
        };
      }
    } catch {
      // JSON parse failed, continue to next approach
    }
  }

  // Try to find shortcode patterns in the HTML source
  // Instagram uses "shortcode":"XXXXX" in embedded JSON data
  const shortcodeMatches = html.match(/"shortcode":"([A-Za-z0-9_-]+)"/g);
  if (shortcodeMatches && shortcodeMatches.length > 0) {
    // Extract the first shortcode (most recent post)
    const match = shortcodeMatches[0].match(/"shortcode":"([A-Za-z0-9_-]+)"/);
    if (match) {
      return {
        shortcode: match[1],
        caption: "", // Cannot reliably extract caption from HTML patterns
        timestamp: null,
      };
    }
  }

  return null;
}

/**
 * Try all approaches in order. Returns the latest post info or null.
 * Order: Graph API (primary) -> web_profile_info -> __a=1 -> HTML scraping
 */
async function fetchLatestPost(username) {
  // Approach 0 (PRIMARY): Instagram Graph API
  if (process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN) {
    try {
      const result = await fetchViaGraphApi();
      if (result) {
        result.method = "graph_api";
        return result;
      }
    } catch (err) {
      console.log(`📸 instagramMonitor: Graph API failed: ${err.message}`);
      // Fall through to scraping approaches
    }
  }

  // Approach 1: web_profile_info API
  try {
    const result = await fetchViaWebProfileInfo(username);
    if (result) {
      result.method = "scraping";
      return result;
    }
  } catch (err) {
    console.log(`📸 instagramMonitor: web_profile_info failed: ${err.message}`);
  }

  // Approach 2: __a=1&__d=dis endpoint
  try {
    const result = await fetchViaJsonEndpoint(username);
    if (result) {
      result.method = "scraping";
      return result;
    }
  } catch (err) {
    console.log(`📸 instagramMonitor: __a=1 endpoint failed: ${err.message}`);
  }

  // Approach 3: HTML scraping
  try {
    const result = await fetchViaHtmlScraping(username);
    if (result) {
      result.method = "scraping";
      return result;
    }
  } catch (err) {
    console.log(`📸 instagramMonitor: HTML scraping failed: ${err.message}`);
  }

  return null;
}

/**
 * Fetch the Nth latest post for the !ig send command.
 * Does NOT update state (lastShortcode etc.) - read-only fetch.
 * @param {number} n - 1-based index (1 = latest, 2 = second latest, etc.)
 * @returns {object|null} Post data or null on failure
 */
async function fetchLatestPostForSend(n = 1) {
  const userId = process.env.IG_USER_ID;
  const accessToken = process.env.IG_ACCESS_TOKEN;
  const username = process.env.IG_USERNAME;

  if (!userId || !accessToken) {
    // Fall back to scraping (only returns latest)
    if (!username) return null;
    if (n > 1) {
      throw new Error("Graph API not configured - cannot fetch older posts, only latest available via scraping");
    }
    return await fetchLatestPost(username);
  }

  const limit = Math.min(Math.max(n, 1), 25);
  const posts = await fetchViaGraphApi(limit);

  if (!posts) return null;

  // If limit was 1, fetchViaGraphApi returns a single object
  if (limit === 1) return posts;

  // Otherwise it returns an array
  if (!Array.isArray(posts) || posts.length < n) return null;
  return posts[n - 1];
}

// ── Notification formatting ────────────────────────────────────────────
function formatNotification(postData) {
  const caption = postData.caption ? `"${postData.caption}"` : "";
  const url = postData.permalink || `https://www.instagram.com/p/${postData.shortcode}/`;
  const isReel = postData.mediaType === "VIDEO";
  const emoji = isReel ? "\uD83C\uDFAC" : "\uD83D\uDCF8"; // 🎬 or 📸
  const typeText = isReel ? "Reel baru" : "Post baru";

  let text = `${emoji} ${typeText} di Instagram!\n`;
  if (caption) {
    text += `\n${caption}\n`;
  }
  text += `\n\uD83D\uDD17 ${url}\n`;
  text += `\nJangan lupa like ya! \u2764\uFE0F`;
  return text;
}

// ── Stored sock reference ──────────────────────────────────────────────
let _sock = null;
let _cronJob = null;

// ── Core polling logic ─────────────────────────────────────────────────
async function pollInstagram() {
  if (!isMonitorEnabled()) return;

  const username = process.env.IG_USERNAME;
  const hasGraphApi = process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN;

  if (!username && !hasGraphApi) {
    console.warn("📸 instagramMonitor: neither IG_USERNAME nor Graph API configured, skipping poll");
    return;
  }

  // Check token expiry on each poll
  await checkTokenExpiry();

  const state = loadState();
  state.lastChecked = new Date().toISOString();

  try {
    const latestPost = await fetchLatestPost(username);

    if (!latestPost) {
      state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
      console.warn(
        `📸 instagramMonitor: no post data found (errors: ${state.consecutiveErrors})`
      );
      saveState(state);
      await handleConsecutiveErrors(state);
      return;
    }

    // Reset error counter on success and track method
    state.consecutiveErrors = 0;
    state.lastMethod = latestPost.method || null;

    // First run: store current post without sending notification (avoid spam on first deploy)
    if (!state.lastShortcode) {
      console.log(
        `📸 instagramMonitor: first run, storing current post: ${latestPost.shortcode}`
      );
      state.lastShortcode = latestPost.shortcode;
      saveState(state);
      return;
    }

    // Check if there is a new post
    if (latestPost.shortcode !== state.lastShortcode) {
      console.log(
        `📸 instagramMonitor: new post detected! ${latestPost.shortcode}`
      );

      // Send notification
      if (_sock) {
        const targetJid = resolveNotifyTarget();
        const text = formatNotification(latestPost);
        await _sock.sendMessage(targetJid, { text });
        console.log(`📸 instagramMonitor: notification sent to ${targetJid}`);
      }

      state.lastShortcode = latestPost.shortcode;
      state.lastNotificationSent = new Date().toISOString();
      state.lastPostUrl = latestPost.permalink || `https://www.instagram.com/p/${latestPost.shortcode}/`;
      state.lastCaption = latestPost.caption || null;
    }

    saveState(state);
  } catch (err) {
    state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
    console.error(
      `❌ instagramMonitor: poll error (errors: ${state.consecutiveErrors}):`,
      err.message
    );
    saveState(state);
    await handleConsecutiveErrors(state);
  }
}

/**
 * Handle consecutive errors: DM owner after 3, log warning after 10.
 */
async function handleConsecutiveErrors(state) {
  if (!_sock) return;

  const errors = state.consecutiveErrors || 0;
  const ownerNum = process.env.OWNER_NUMBER;
  if (!ownerNum) return;

  if (errors === 3) {
    const targetJid = `${ownerNum}@s.whatsapp.net`;
    try {
      await _sock.sendMessage(targetJid, {
        text:
          `\u26A0\uFE0F Instagram monitor: ${errors} consecutive errors.\n` +
          `Scraping mungkin diblokir atau Instagram mengubah struktur halaman.\n` +
          `Cek log untuk detail.`,
      });
    } catch {
      // Ignore send failure
    }
  }

  if (errors >= 10) {
    console.warn(
      `📸 instagramMonitor: ${errors} consecutive errors, but will keep retrying`
    );
  }
}

// ── Cron-based polling with random delay ───────────────────────────────
function startInstagramMonitor(sock) {
  _sock = sock;

  if ((process.env.IG_MONITOR_ENABLED || "true").toLowerCase() === "false") {
    console.log("📸 instagramMonitor: disabled via IG_MONITOR_ENABLED=false");
    return;
  }

  const username = process.env.IG_USERNAME;
  const hasGraphApi = process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN;

  if (!username && !hasGraphApi) {
    console.log("📸 instagramMonitor: neither IG_USERNAME nor Graph API (IG_USER_ID+IG_ACCESS_TOKEN) set, monitor inactive");
    return;
  }

  const cronExpr = process.env.IG_CHECK_CRON || "*/5 * * * *";

  if (_cronJob) {
    _cronJob.stop();
  }

  _cronJob = cron.schedule(cronExpr, () => {
    // Add random delay (0-30 seconds) to avoid looking like a bot
    const delay = Math.floor(Math.random() * 30000);
    setTimeout(() => {
      pollInstagram().catch((err) => {
        console.error("❌ instagramMonitor: unhandled poll error:", err.message);
      });
    }, delay);
  });

  const method = hasGraphApi ? "Graph API (primary)" : "scraping only";
  const target = username ? `@${username}` : `user ${process.env.IG_USER_ID}`;
  console.log(`📸 instagramMonitor: started polling ${target} via ${method} (cron: ${cronExpr})`);
}

// ── Manual trigger ─────────────────────────────────────────────────────
async function checkInstagramNow(sock) {
  const activeSock = sock || _sock;
  if (activeSock) _sock = activeSock;

  const username = process.env.IG_USERNAME;
  const hasGraphApi = process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN;

  if (!username && !hasGraphApi) {
    return { success: false, reason: "Neither IG_USERNAME nor Graph API configured" };
  }

  try {
    const latestPost = await fetchLatestPost(username);
    if (!latestPost) {
      return { success: false, reason: "Could not fetch post data from Instagram" };
    }

    const state = loadState();
    state.lastChecked = new Date().toISOString();
    state.lastMethod = latestPost.method || null;

    if (!state.lastShortcode) {
      // First check ever: store and don't notify
      state.lastShortcode = latestPost.shortcode;
      state.consecutiveErrors = 0;
      saveState(state);
      return {
        success: true,
        newPost: false,
        message: `First check - stored current post: ${latestPost.shortcode} (via ${latestPost.method || "unknown"})`,
      };
    }

    if (latestPost.shortcode !== state.lastShortcode) {
      // New post found - send notification
      if (_sock) {
        const targetJid = resolveNotifyTarget();
        const text = formatNotification(latestPost);
        await _sock.sendMessage(targetJid, { text });
      }

      state.lastShortcode = latestPost.shortcode;
      state.lastNotificationSent = new Date().toISOString();
      state.lastPostUrl = latestPost.permalink || `https://www.instagram.com/p/${latestPost.shortcode}/`;
      state.lastCaption = latestPost.caption || null;
      state.consecutiveErrors = 0;
      saveState(state);

      return {
        success: true,
        newPost: true,
        shortcode: latestPost.shortcode,
        message: `New post found and notified: ${latestPost.shortcode} (via ${latestPost.method || "unknown"})`,
      };
    }

    state.consecutiveErrors = 0;
    saveState(state);
    return {
      success: true,
      newPost: false,
      message: `No new posts. Latest: ${latestPost.shortcode} (via ${latestPost.method || "unknown"})`,
    };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ── Webhook handler (kept as fallback for future Make.com integration) ──
/**
 * Handle an incoming webhook POST with Instagram post data.
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

  try {
    await activeSock.sendMessage(targetJid, { text });
    console.log(`📸 instagramMonitor: webhook notification sent to ${targetJid}`);

    // Update state
    const state = loadState();
    state.lastNotificationSent = new Date().toISOString();
    state.lastPostUrl = postData.url || postData.source_url || null;
    state.lastCaption = postData.caption || null;
    state.consecutiveErrors = 0;
    saveState(state);

    return { success: true };
  } catch (err) {
    console.error("❌ instagramMonitor: failed to send notification:", err.message);
    return { success: false, reason: err.message };
  }
}

// ── Public API ─────────────────────────────────────────────────────────
function getIgStatus() {
  const state = loadState();
  const envEnabled = (process.env.IG_MONITOR_ENABLED || "true").toLowerCase() !== "false";
  const cronExpr = process.env.IG_CHECK_CRON || "*/5 * * * *";
  const username = process.env.IG_USERNAME || "(not set)";
  const hasGraphApi = Boolean(process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN);
  const tokenExpiresAt = process.env.IG_TOKEN_EXPIRES_AT || null;

  // Determine current mode description
  let mode;
  if (hasGraphApi) {
    mode = "Graph API (primary) + scraping (fallback)";
  } else if (username !== "(not set)") {
    mode = "scraping (fallback only)";
  } else {
    mode = "not configured";
  }

  return {
    enabled: envEnabled && state.enabled,
    envEnabled,
    stateEnabled: state.enabled,
    username,
    cronExpression: cronExpr,
    lastChecked: state.lastChecked || null,
    lastNotificationSent: state.lastNotificationSent || null,
    lastPostUrl: state.lastPostUrl || null,
    lastShortcode: state.lastShortcode || null,
    lastCaption: state.lastCaption || null,
    consecutiveErrors: state.consecutiveErrors || 0,
    notifyTarget: process.env.IG_NOTIFY_TARGET || "owner",
    mode,
    graphApiConfigured: hasGraphApi,
    tokenExpiresAt,
    lastMethod: state.lastMethod || null,
  };
}

function setIgEnabled(enabled) {
  const state = loadState();
  state.enabled = Boolean(enabled);
  saveState(state);
  return state.enabled;
}

module.exports = {
  startInstagramMonitor,
  handleWebhookPost,
  getIgStatus,
  setIgEnabled,
  checkInstagramNow,
  fetchLatestPostForSend,
  formatNotification,
  resolveNotifyTarget,
};
