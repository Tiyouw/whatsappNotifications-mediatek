const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
const { getReminders, markAsDone, addReminder, deleteReminder } = require("./sheets");
const { triggerManualCheck, sendWeeklySummary } = require("./scheduler");
const { convertImageToSticker, convertVideoToSticker } = require("./stickerHandler");
const { handleWebhookPost, getIgStatus } = require("./instagramMonitor");
const { now } = require("./time");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || process.env.API_SECRET || "";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

function resolveDamnStickerPath() {
  const raw = process.env.DAMN_STICKER_PATH || "./data/damn.webp";
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

function startDashboardServer(getSock) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");

      if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/dashboard")) {
        return serveFile(req, res, "dashboard.html", "text/html; charset=utf-8");
      }

      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/dashboard.css") {
        return serveFile(req, res, "dashboard.css", "text/css; charset=utf-8");
      }

      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/dashboard.js") {
        return serveFile(req, res, "dashboard.js", "application/javascript; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return sendText(res, 200, "Bot is running");
      }

      // ── Instagram IFTTT Webhook ────────────────────────────────────────
      if (url.pathname === "/webhook/instagram" && req.method === "POST") {
        const webhookSecret = process.env.IG_WEBHOOK_SECRET || "";
        if (!webhookSecret) {
          return sendJson(res, 503, { error: "IG_WEBHOOK_SECRET not configured" });
        }

        // Auth: check Bearer token header or ?token= query param
        const authHeader = req.headers.authorization || "";
        const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        const queryToken = url.searchParams.get("token") || "";
        const providedToken = bearer || queryToken;

        if (!providedToken || !safeEqual(providedToken, webhookSecret)) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }

        // Check if monitor is enabled
        const igStatus = getIgStatus();
        if (!igStatus.enabled) {
          return sendJson(res, 503, { error: "Instagram monitor is disabled" });
        }

        // Check sock availability
        const sock = getSock();
        if (!sock) {
          return sendJson(res, 503, { error: "WhatsApp socket is not connected yet." });
        }

        // Parse body (JSON or form-urlencoded)
        const body = await readBody(req);

        // Support simpler share-target format: { url: "...", caption: "..." }
        // alongside existing IFTTT format: { caption, url, source_url, created_at }
        if (body.url && !body.source_url && !body.created_at) {
          // Simple share-target format - use smart emoji detection
          const shareUrl = body.url || "";

          let emoji = "\uD83D\uDCE2"; // 📢
          let title = "Post baru!";
          if (shareUrl.toLowerCase().includes("instagram.com")) {
            emoji = "\uD83D\uDCF8"; // 📸
            title = "Post baru di Instagram!";
          } else if (shareUrl.toLowerCase().includes("tiktok.com")) {
            emoji = "\uD83C\uDFB5"; // 🎵
            title = "Video baru di TikTok!";
          }

          let notifText = `${emoji} ${title}\n`;
          notifText += `\n\uD83D\uDD17 ${shareUrl}\n`;
          notifText += `\nJangan lupa like ya! \u2764\uFE0F`;

          const targetRaw = process.env.IG_NOTIFY_TARGET || "owner";
          const targetJid = targetRaw === "owner"
            ? `${process.env.OWNER_NUMBER}@s.whatsapp.net`
            : targetRaw;

          try {
            await sock.sendMessage(targetJid, { text: notifText });
            return sendJson(res, 200, { ok: true });
          } catch (err) {
            return sendJson(res, 500, { error: err.message || "Failed to send notification" });
          }
        }

        const result = await handleWebhookPost(sock, body);
        if (result.success) {
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 500, { error: result.reason || "Failed to send notification" });
      }

      if (url.pathname === "/api/dashboard/config" && req.method === "GET") {
        return sendJson(res, 200, {
          authRequired: Boolean(DASHBOARD_TOKEN) || IS_PRODUCTION,
          configured: Boolean(DASHBOARD_TOKEN) || !IS_PRODUCTION,
        });
      }

      if (url.pathname.startsWith("/api/")) {
        const auth = requireDashboardAuth(req, res);
        if (!auth.ok) return;
      }

      if (url.pathname === "/api/reminders" && req.method === "GET") {
        const reminders = await getReminders({ includeInactive: true });
        return sendJson(res, 200, {
          reminders: reminders.map(serializeReminder),
          generatedAt: now().toISOString(),
        });
      }

      if (url.pathname === "/api/reminders" && req.method === "POST") {
        const body = await readJson(req);
        const task = String(body.task || "").trim();
        const deadline = String(body.deadline || "").trim();
        const notifyDays = String(body.notifyDays || process.env.NOTIFY_DAYS_BEFORE || "7,3,1,0").trim();
        const notes = String(body.notes || "").trim();
        const target = String(body.target || process.env.OWNER_NUMBER || "").trim();

        if (!task || !deadline) {
          return sendJson(res, 400, { error: "Task and deadline are required." });
        }

        const success = await addReminder({ task, deadline, target, notifyDays, notes });
        if (!success) return sendJson(res, 500, { error: "Failed to add reminder." });
        return sendJson(res, 201, { ok: true });
      }

      const doneMatch = url.pathname.match(/^\/api\/reminders\/(\d+)\/done$/);
      if (doneMatch && req.method === "POST") {
        const result = await findReminderAndRun(Number(doneMatch[1]), (reminder) =>
          markAsDone(reminder, "Dashboard")
        );
        return sendJson(res, result.status, result.body);
      }

      const skipMatch = url.pathname.match(/^\/api\/reminders\/(\d+)\/skip$/);
      if (skipMatch && req.method === "POST") {
        const result = await findReminderAndRun(Number(skipMatch[1]), deleteReminder);
        return sendJson(res, result.status, result.body);
      }

      if (url.pathname === "/api/actions/send-due" && req.method === "POST") {
        const sock = getSock();
        if (!sock) return sendJson(res, 503, { error: "WhatsApp socket is not connected yet." });
        await triggerManualCheck(sock);
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === "/api/actions/weekly-summary" && req.method === "POST") {
        const sock = getSock();
        if (!sock) return sendJson(res, 503, { error: "WhatsApp socket is not connected yet." });
        await sendWeeklySummary(sock);
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === "/api/stickers/damn" && req.method === "GET") {
        try {
          const sticker = await fs.readFile(resolveDamnStickerPath());
          res.writeHead(200, {
            "Content-Type": "image/webp",
            "Cache-Control": "no-store",
          });
          return res.end(sticker);
        } catch {
          return sendJson(res, 404, { error: "Sticker !damn is not available yet." });
        }
      }

      if (url.pathname === "/api/stickers/damn" && req.method === "POST") {
        const body = await readJson(req);
        const mimeType = String(body.mimeType || "");
        const data = String(body.data || "");
        const base64 = data.includes(",") ? data.split(",").pop() : data;
        if (!base64 || !mimeType) return sendJson(res, 400, { error: "Sticker file is required." });

        const buffer = Buffer.from(base64, "base64");
        const isVideo = mimeType.startsWith("video/");
        const sticker = isVideo
          ? await convertVideoToSticker(buffer, mimeType)
          : await convertImageToSticker(buffer);

        const stickerPath = resolveDamnStickerPath();
        await fs.mkdir(path.dirname(stickerPath), { recursive: true });
        await fs.writeFile(stickerPath, sticker);
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === "/api/stickers/damn/send" && req.method === "POST") {
        const sock = getSock();
        if (!sock) return sendJson(res, 503, { error: "WhatsApp socket is not connected yet." });

        const body = await readJson(req);
        const target = String(body.target || process.env.OWNER_NUMBER || "").trim();
        const jid = resolveTargetJid(target);
        if (!jid) return sendJson(res, 400, { error: "Valid target number or group JID is required." });

        const sticker = await fs.readFile(resolveDamnStickerPath());
        await sock.sendMessage(jid, { sticker });
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      console.error("Dashboard server error:", err);
      return sendJson(res, 500, { error: err.message || "Internal server error" });
    }
  });

  server.listen(3000, () => {
    console.log("🌐 Dashboard server listening on port 3000");
  });
}

async function findReminderAndRun(globalNo, action) {
  const reminders = await getReminders({ includeInactive: true });
  const reminder = reminders.find((r) => r.globalNo === globalNo);
  if (!reminder) return { status: 404, body: { error: `Reminder ${globalNo} not found.` } };

  const result = await action(reminder);
  if (!result?.success) {
    return { status: 500, body: { error: result?.reason || "Action failed." } };
  }
  return { status: 200, body: { ok: true } };
}

function serializeReminder(reminder) {
  const today = now().startOf("day");
  const daysLeft = reminder.deadline.startOf("day").diff(today, "day");
  return {
    globalNo: reminder.globalNo,
    no: reminder.no,
    task: reminder.task,
    deadline: reminder.rawDeadline || reminder.deadline.format("YYYY-MM-DD"),
    target: reminder.target,
    notifyDays: reminder.notifyDays,
    notes: reminder.notes,
    status: reminder.status,
    source: reminder.source,
    approval: reminder.approval,
    tabName: reminder.tabName,
    daysLeft,
  };
}

async function serveFile(req, res, fileName, contentType) {
  const filePath = path.join(PUBLIC_DIR, fileName);
  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : content);
}

function resolveTargetJid(target) {
  if (!target) return "";
  if (target.includes("@g.us") || target.includes("@s.whatsapp.net")) return target;
  const cleaned = target.replace(/\D/g, "");
  if (cleaned.length < 10) return "";
  const normalized = cleaned.startsWith("0") ? `62${cleaned.slice(1)}` : cleaned;
  return `${normalized}@s.whatsapp.net`;
}

function requireDashboardAuth(req, res) {
  if (!DASHBOARD_TOKEN) {
    if (!IS_PRODUCTION) return { ok: true };
    sendJson(res, 503, {
      error: "Dashboard auth is not configured. Set DASHBOARD_TOKEN or API_SECRET on Fly.",
    });
    return { ok: false };
  }

  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const token = req.headers["x-dashboard-token"] || bearer;

  if (!safeEqual(String(token || ""), DASHBOARD_TOKEN)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return { ok: false };
  }

  return { ok: true };
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 30_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Read request body, supporting both JSON and form-urlencoded (IFTTT sends either).
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      const contentType = (req.headers["content-type"] || "").toLowerCase();
      if (contentType.includes("application/json")) {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid JSON"));
        }
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        const params = new URLSearchParams(data);
        const obj = {};
        for (const [key, value] of params.entries()) {
          obj[key] = value;
        }
        resolve(obj);
      } else {
        // Try JSON first, fall back to form-urlencoded
        try {
          resolve(JSON.parse(data));
        } catch {
          try {
            const params = new URLSearchParams(data);
            const obj = {};
            for (const [key, value] of params.entries()) {
              obj[key] = value;
            }
            resolve(obj);
          } catch {
            reject(new Error("Unsupported content type"));
          }
        }
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

module.exports = { startDashboardServer };
