const PAGE_SIZE = 8;

const state = {
  reminders: [],
  filter: "all",
  page: 1,
  view: "dashboard",
  token: localStorage.getItem("reo_dashboard_token") || "",
};

const els = {
  authPanel: document.getElementById("authPanel"),
  authForm: document.getElementById("authForm"),
  tokenInput: document.getElementById("tokenInput"),
  reminderList: document.getElementById("reminderList"),
  dashboardList: document.getElementById("dashboardList"),
  template: document.getElementById("reminderTemplate"),
  activeCount: document.getElementById("activeCount"),
  overdueCount: document.getElementById("overdueCount"),
  dueTodayCount: document.getElementById("dueTodayCount"),
  activityLog: document.getElementById("activityLog"),
  connectionLabel: document.getElementById("connectionLabel"),
  refreshBtn: document.getElementById("refreshBtn"),
  addForm: document.getElementById("addForm"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  pageLabel: document.getElementById("pageLabel"),
  viewTitle: document.getElementById("viewTitle"),
  viewEyebrow: document.getElementById("viewEyebrow"),
  stickerForm: document.getElementById("stickerForm"),
  sendStickerForm: document.getElementById("sendStickerForm"),
  reloadStickerBtn: document.getElementById("reloadStickerBtn"),
  damnPreview: document.getElementById("damnPreview"),
  stickerEmpty: document.getElementById("stickerEmpty"),
};

boot();

async function boot() {
  bindEvents();
  await loadConfig();
  if (state.token) {
    await loadReminders();
    await loadStickerPreview();
  }
  setView("dashboard");
}

function bindEvents() {
  els.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.token = els.tokenInput.value.trim();
    localStorage.setItem("reo_dashboard_token", state.token);
    log("Token saved in this browser.");
    await loadReminders();
    await loadStickerPreview();
  });

  els.refreshBtn.addEventListener("click", async () => {
    await loadReminders();
    if (state.view === "stickers") await loadStickerPreview();
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  document.querySelectorAll("[data-view-shortcut]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.viewShortcut));
  });

  document.querySelectorAll(".filter").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.filter = button.dataset.filter;
      state.page = 1;
      render();
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runAction(button.dataset.action));
  });

  els.prevPageBtn.addEventListener("click", () => {
    state.page = Math.max(1, state.page - 1);
    renderReminderList();
  });

  els.nextPageBtn.addEventListener("click", () => {
    const totalPages = getTotalPages();
    state.page = Math.min(totalPages, state.page + 1);
    renderReminderList();
  });

  els.addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(els.addForm);
    const payload = Object.fromEntries(form.entries());
    await api("/api/reminders", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    els.addForm.reset();
    els.addForm.notifyDays.value = "7,3,1,0";
    log(`Created reminder: ${payload.task}`);
    await loadReminders();
  });

  els.stickerForm.addEventListener("submit", updateDamnSticker);
  els.sendStickerForm.addEventListener("submit", sendDamnSticker);
  els.reloadStickerBtn.addEventListener("click", loadStickerPreview);
}

function setView(view) {
  if (view === "logout") {
    logout();
    return;
  }

  state.view = view;
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === view);
  });

  const titles = {
    dashboard: ["WhatsApp command center", "ReoOnCavern"],
    stickers: ["Sticker console", "Stickers"],
    reminders: ["Full reminder list", "Reminders"],
  };
  const [eyebrow, title] = titles[view] || titles.dashboard;
  els.viewEyebrow.textContent = eyebrow;
  els.viewTitle.textContent = title;

  if (view === "stickers" && state.token) loadStickerPreview();
  render();
}

function logout() {
  state.token = "";
  localStorage.removeItem("reo_dashboard_token");
  els.authPanel.classList.remove("hidden");
  els.connectionLabel.textContent = "Token reset";
  log("Dashboard token removed from this browser.");
}

async function loadConfig() {
  try {
    const res = await fetch("/api/dashboard/config");
    const config = await res.json();
    if (!config.configured) {
      els.authPanel.classList.remove("hidden");
      els.connectionLabel.textContent = "Auth not configured";
      log("Set DASHBOARD_TOKEN or API_SECRET on Fly before using the dashboard.");
      return;
    }
    if (config.authRequired && !state.token) {
      els.authPanel.classList.remove("hidden");
      els.connectionLabel.textContent = "Token required";
      return;
    }
    els.authPanel.classList.toggle("hidden", Boolean(state.token));
  } catch (err) {
    log(err.message);
  }
}

async function loadReminders() {
  try {
    const data = await api("/api/reminders");
    state.reminders = data.reminders || [];
    els.authPanel.classList.add("hidden");
    els.connectionLabel.textContent = "Connected";
    log(`Loaded ${state.reminders.length} reminders.`);
    render();
  } catch (err) {
    els.connectionLabel.textContent = "API error";
    els.authPanel.classList.remove("hidden");
    log(err.message);
  }
}

async function runAction(action) {
  const labels = {
    "send-due": "Send all due reminders now?",
    "weekly-summary": "Send weekly summary to owner now?",
  };
  const doneLabels = {
    "send-due": "Sent due reminders.",
    "weekly-summary": "Sent weekly summary.",
  };

  if (!confirm(labels[action] || `Run ${action}?`)) return;
  await api(`/api/actions/${action}`, { method: "POST" });
  log(doneLabels[action] || `Ran ${action}.`);
}

async function markDone(globalNo) {
  if (!confirm(`Mark reminder ${globalNo} as done?`)) return;
  await api(`/api/reminders/${globalNo}/done`, { method: "POST" });
  log(`Marked reminder ${globalNo} as done.`);
  await loadReminders();
}

async function skipReminder(globalNo) {
  if (!confirm(`Skip reminder ${globalNo}?`)) return;
  await api(`/api/reminders/${globalNo}/skip`, { method: "POST" });
  log(`Skipped reminder ${globalNo}.`);
  await loadReminders();
}

async function updateDamnSticker(event) {
  event.preventDefault();
  const file = els.stickerForm.stickerFile.files[0];
  if (!file) return;
  if (!confirm("Update the !damn sticker with this file?")) return;

  const data = await readFileAsDataUrl(file);
  await api("/api/stickers/damn", {
    method: "POST",
    body: JSON.stringify({ data, mimeType: file.type }),
  });
  els.stickerForm.reset();
  log("Updated !damn sticker.");
  await loadStickerPreview();
}

async function sendDamnSticker(event) {
  event.preventDefault();
  const form = new FormData(els.sendStickerForm);
  const target = String(form.get("target") || "").trim();
  if (!confirm(target ? `Send !damn sticker to ${target}?` : "Send !damn sticker to owner?")) return;
  await api("/api/stickers/damn/send", {
    method: "POST",
    body: JSON.stringify({ target }),
  });
  log("Sent !damn sticker.");
}

async function loadStickerPreview() {
  if (!state.token) return;
  try {
    const res = await fetch("/api/stickers/damn", {
      headers: { "X-Dashboard-Token": state.token },
    });
    if (!res.ok) throw new Error("No !damn sticker available yet.");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (els.damnPreview.dataset.url) URL.revokeObjectURL(els.damnPreview.dataset.url);
    els.damnPreview.dataset.url = url;
    els.damnPreview.src = url;
    els.damnPreview.classList.remove("hidden");
    els.stickerEmpty.classList.add("hidden");
  } catch (err) {
    els.damnPreview.classList.add("hidden");
    els.stickerEmpty.classList.remove("hidden");
    els.stickerEmpty.textContent = err.message;
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Dashboard-Token": state.token,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

function render() {
  renderStats();
  renderDashboardList();
  renderReminderList();
}

function renderStats() {
  const active = state.reminders.filter((item) => item.status === "active");
  const overdue = active.filter((item) => item.daysLeft < 0);
  const dueToday = active.filter((item) => item.daysLeft === 0);

  els.activeCount.textContent = active.length;
  els.overdueCount.textContent = overdue.length;
  els.dueTodayCount.textContent = `${dueToday.length} due today`;
}

function renderDashboardList() {
  const upcoming = filteredReminders("active").slice(0, 5);
  renderRows(els.dashboardList, upcoming, { compact: true });
}

function renderReminderList() {
  const reminders = filteredReminders();
  const totalPages = getTotalPages(reminders);
  state.page = Math.min(Math.max(state.page, 1), totalPages);
  const start = (state.page - 1) * PAGE_SIZE;
  const pageItems = reminders.slice(start, start + PAGE_SIZE);

  renderRows(els.reminderList, pageItems);
  els.pageLabel.textContent = `Page ${state.page} of ${totalPages} - ${reminders.length} items`;
  els.prevPageBtn.disabled = state.page <= 1;
  els.nextPageBtn.disabled = state.page >= totalPages;
}

function renderRows(container, reminders, options = {}) {
  container.textContent = "";

  if (!reminders.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No reminders match this view.";
    container.appendChild(empty);
    return;
  }

  for (const reminder of reminders) {
    const node = els.template.content.firstElementChild.cloneNode(true);
    node.classList.toggle("overdue", reminder.status === "active" && reminder.daysLeft < 0);
    node.classList.toggle("is-done", reminder.status === "done");
    node.classList.toggle("is-skip", reminder.status === "skip");
    node.querySelector(".number").textContent = reminder.globalNo;
    node.querySelector("h3").textContent = reminder.task;
    node.querySelector("p").textContent = describe(reminder);

    const source = node.querySelector(".source");
    source.textContent = reminder.source;

    const status = node.querySelector(".status");
    status.textContent = reminder.status;
    status.classList.add(reminder.status);

    const doneButton = node.querySelector(".done-button");
    const skipButton = node.querySelector(".skip-button");
    doneButton.disabled = reminder.status === "done";
    skipButton.disabled = reminder.status === "skip";
    doneButton.addEventListener("click", () => markDone(reminder.globalNo));
    skipButton.addEventListener("click", () => skipReminder(reminder.globalNo));

    if (options.compact) {
      skipButton.remove();
    }

    container.appendChild(node);
  }
}

function getTotalPages(items = filteredReminders()) {
  return Math.max(1, Math.ceil(items.length / PAGE_SIZE));
}

function filteredReminders(filter = state.filter) {
  const sorted = [...state.reminders].sort((a, b) => {
    const statusA = a.status === "active" ? 0 : 1;
    const statusB = b.status === "active" ? 0 : 1;
    if (statusA !== statusB) return statusA - statusB;
    return new Date(a.deadline) - new Date(b.deadline);
  });

  if (filter === "all") return sorted;
  if (filter === "overdue") {
    return sorted.filter((item) => item.status === "active" && item.daysLeft < 0);
  }
  return sorted.filter((item) => item.status === filter);
}

function describe(reminder) {
  const date = new Date(`${reminder.deadline}T00:00:00`);
  const deadline = Number.isNaN(date.getTime())
    ? reminder.deadline
    : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const timing = timingLabel(reminder);
  const notes = reminder.notes ? ` - ${reminder.notes}` : "";
  return `${deadline} - ${timing} - ${reminder.tabName}${notes}`;
}

function timingLabel(reminder) {
  if (reminder.status === "done") return "completed";
  if (reminder.status === "skip") return "skipped";
  if (reminder.daysLeft < 0) return `${Math.abs(reminder.daysLeft)} days overdue`;
  if (reminder.daysLeft === 0) return "due today";
  if (reminder.daysLeft === 1) return "due tomorrow";
  return `${reminder.daysLeft} days left`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function log(message) {
  const item = document.createElement("div");
  item.className = "activity-item";
  item.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
  els.activityLog.prepend(item);
  while (els.activityLog.children.length > 8) {
    els.activityLog.lastElementChild.remove();
  }
}
