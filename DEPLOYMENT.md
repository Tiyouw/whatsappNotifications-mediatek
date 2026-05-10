# Fly.io Deployment Runbook

This document walks through deploying the WhatsApp reminder bot to [Fly.io](https://fly.io) from a **Windows 10/11 machine using PowerShell 5+**. The commands are written for `powershell.exe`; if you use WSL or Git Bash the `iwr | iex` installer and the `C:\Users\<you>\...` paths will need to be adapted.

> **The single most important rule:** seed the Fly volume with the existing Baileys session **before** the first `fly deploy`. If the bot boots without session state it will print a QR in the logs, and you cannot scan a QR on a headless cloud VM. You would have to log out the WhatsApp device, reset, and start fresh.

---

## 0. Prerequisites

Before you start, prepare a local staging folder on your laptop, e.g. `C:\Users\<you>\wa-bot-migration\`. Put the following files in it:

| File | Where it comes from |
| --- | --- |
| `auth_info_baileys.tar.gz` | `tar -czf auth_info_baileys.tar.gz auth_info_baileys/` run in the project root on your current host (Replit download / local machine). Contains `creds.json`, `pre-key-*.json`, `sender-key-*.json`, `app-state-sync-*.json`, `session-*.json`. |
| `data_backup.tar.gz` | `tar -czf data_backup.tar.gz -C data damn.webp reactionMap.json` (if `reactionMap.json` does not exist yet you can skip it or create an empty `{}`). |
| `credentials.json` | Google service-account key JSON you already use locally. |
| `.env` (for reference) | Your current `.env` with all secret values filled in. You will NOT upload this; you will feed the values to `flyctl secrets set` in step 4. |

You also need:

- A Fly.io account with a valid payment method configured (free tier is effectively deprecated; expect roughly **$2–3/mo** for one `shared-cpu-1x` 512MB machine in `sin` plus a 1GB volume).
- PowerShell 5 or later (built into Windows 10/11).

---

## 1. Install flyctl and sign in

```powershell
# One-line installer from Fly. This writes flyctl to %USERPROFILE%\.fly\bin.
iwr https://fly.io/install.ps1 -useb | iex

# Close and reopen PowerShell so the updated PATH is picked up.
# Then verify:
flyctl version

# Browser-based login. Opens your default browser.
flyctl auth login
```

---

## 2. Create the app

App names on Fly are **globally unique across all Fly customers**. `wa-reminder-bot` is almost certainly already taken, so pick a personal suffix. Example:

```powershell
$APP = "wa-reminder-bot-tio"   # replace with your own suffix
flyctl apps create $APP
```

Then update `app = "wa-reminder-bot"` in `fly.toml` to match whatever name you chose, commit, and push, or pass `--app $APP` to every `flyctl` command below (the examples do both).

---

## 3. Create the persistent volume

```powershell
flyctl volumes create wa_data --size 1 --region sin --yes --app $APP
```

- `wa_data` is the volume name; it must match the `source` field in `fly.toml`'s `[[mounts]]` block exactly. Do not rename one without the other.
- 1GB is plenty for the session + sticker + reactionMap. You can grow the volume later with `flyctl volumes extend` but you **cannot shrink** it.
- The region (`sin`) must match `primary_region` in `fly.toml`.

---

## 4. Set secrets

All the values your bot needs at runtime that are either sensitive or change per-deploy go through `flyctl secrets set`. These are NOT in `fly.toml` — Fly encrypts them at rest and injects them as env vars into the container. Substitute your real values for every placeholder below, then paste the whole multi-line command into PowerShell:

```powershell
flyctl secrets set `
  SPREADSHEET_ID="your_spreadsheet_id_here" `
  SHEET_REMINDER_TAB="Reminders" `
  SHEET_MANUAL_TAB="MyReminders" `
  SHEET_OVERRIDE_TAB="BotOverrides" `
  OWNER_NUMBER="628xxxxxxxxxx" `
  ALLOWED_NUMBERS="628xxxxxxxxxx,628yyyyyyyyyy" `
  ALLOWED_LIDS="125812544147601" `
  DEFAULT_GROUP_JID="120363xxxxxxxxxxxx@g.us" `
  REMINDER_CRON="0 8 * * *" `
  NOTIFY_DAYS_BEFORE="7,3,1,0" `
  NUMBER_NAME_MAP="628xxxxxxxxxx=Alice,628yyyyyyyyyy=Bob" `
  DONE_REQUIRE_OWNER_APPROVAL="false" `
  DONE_APPROVAL_TTL_MS="900000" `
  APPROVER_NUMBERS="OWNER_NUMBER,628zzzzzzzzzz" `
  APPROVER_LABEL="Abang" `
  --app $APP
```

Notes:

- `DONE_REQUIRE_OWNER_APPROVAL`, `DONE_APPROVAL_TTL_MS`, `APPROVER_NUMBERS`, and `APPROVER_LABEL` are optional; omit them if you do not use the approval flow.
- **Do NOT set `AUTH_DIR`, `REACTION_MAP_PATH`, `DAMN_STICKER_PATH`, or `GOOGLE_CREDENTIALS_PATH` via `flyctl secrets`.** Those are path values, not secrets, and they are already defined in `fly.toml`'s `[env]` block pointing at `/data/...`. Defining them as secrets too would be harmless but confusing; leave them out.
- `flyctl secrets set` triggers an app restart as soon as a machine exists. Before the first deploy the app has zero machines, so the secrets are just staged for when the machine boots.

---

## 5. SEED THE VOLUME (before first deploy)

This is the critical step. Your goal: by the time `fly deploy` launches the real bot, `/data/auth_info_baileys/creds.json`, `/data/credentials.json`, `/data/damn.webp`, and optionally `/data/reactionMap.json` must already be present on the volume. Two options follow; **Option 1 is recommended** because it never puts session state into a Docker registry.

### Option 1 — SFTP via a throwaway machine (recommended)

Spin up a disposable machine that just sits there with the volume attached, then push files to it over Fly's SSH-tunnelled SFTP.

```powershell
# Launch a short-lived machine with the volume attached. `alpine` is tiny;
# if pulling from Docker Hub fails for any reason, swap to `debian:stable-slim`.
flyctl machine run alpine `
  --volume wa_data:/data `
  --region sin `
  --app $APP `
  -- sleep 3600
```

Grab the machine ID it prints (e.g. `148e123456d789`) — you will destroy this machine in step 7. Then open the SFTP shell:

```powershell
flyctl ssh sftp shell --app $APP

# Inside the sftp shell:
put C:\Users\<you>\wa-bot-migration\auth_info_baileys.tar.gz /data/auth_info_baileys.tar.gz
put C:\Users\<you>\wa-bot-migration\data_backup.tar.gz       /data/data_backup.tar.gz
put C:\Users\<you>\wa-bot-migration\credentials.json         /data/credentials.json
quit
```

Now extract the tars in place:

```powershell
flyctl ssh console --app $APP --command "sh -lc 'cd /data && tar -xzf auth_info_baileys.tar.gz && tar -xzf data_backup.tar.gz && rm auth_info_baileys.tar.gz data_backup.tar.gz && ls -lR /data'"
```

**Expected final layout:**

```
/data/
  auth_info_baileys/
    creds.json
    pre-key-*.json
    sender-key-*.json
    app-state-sync-*.json
    session-*.json
  credentials.json
  damn.webp
  reactionMap.json   (optional)
```

#### Tar layout troubleshooting

If `tar -tzf auth_info_baileys.tar.gz` on your laptop shows entries like `auth_info_baileys/creds.json` (with a leading folder), the layout above happens automatically. If instead it shows `creds.json`, `pre-key-0.json`, ... at the root of the tar, the files will extract straight into `/data/` and you must reorganize:

```powershell
flyctl ssh console --app $APP --command "sh -lc 'cd /data && mkdir -p auth_info_baileys && mv creds.json pre-key-*.json sender-key-*.json app-state-sync-*.json session-*.json auth_info_baileys/ && ls -l auth_info_baileys'"
```

If `data_backup.tar.gz` was created with `tar -czf ... -C data damn.webp reactionMap.json` (as suggested in step 0), `damn.webp` and `reactionMap.json` land directly in `/data/`, which is what we want — they do **not** go into a `data/` subfolder on the volume.

### Option 2 — Seeder Dockerfile (alternative, not recommended for session data)

Build a one-off image that `COPY`s the session files in, deploy once, then replace with the real Dockerfile. The downside is that your WhatsApp session ends up in the Docker registry (and in your local Docker image cache), which is a bad habit for long-lived linked-device credentials. Use Option 1 unless SFTP is genuinely not working for you.

---

## 6. Verify the volume

Before moving on, confirm everything is actually on the volume:

```powershell
flyctl ssh console --app $APP --command "ls -lh /data/auth_info_baileys /data/credentials.json /data/damn.webp /data/reactionMap.json 2>&1"
```

Sanity checks:

- `creds.json` should be roughly 1.5–2 KB (non-empty JSON).
- `credentials.json` should be roughly 2–3 KB (non-empty JSON with a `private_key` field).
- `damn.webp` should be the sticker you created earlier (a few dozen KB).
- `reactionMap.json` may be absent or contain `{}` — both are fine; the code creates it on first write.

If any file is missing or zero bytes, re-run the `put` commands in step 5 and extract again before deploying.

---

## 7. Destroy the seeder machine

Fly volumes are **single-attacher**: only one machine can mount a given volume at a time. If the seeder from step 5 is still alive, the real bot's machine will fail to start because it cannot mount `wa_data`. Kill the seeder first:

```powershell
flyctl machine list --app $APP
# note the seeder's machine ID from the output
flyctl machine destroy <machine-id> --force --app $APP
```

---

## 8. Deploy the real bot

```powershell
flyctl deploy --app $APP
```

Watch the output. You should see:

1. Docker image builds locally or on Fly's remote builder.
2. Image pushed to Fly's registry.
3. A new machine launches in `sin`.
4. Health checks on `/` pass (the keep-alive server replies `Bot is running`).

---

## 9. Verify there is no QR in the logs

```powershell
flyctl logs --app $APP
```

**Good signs** (Baileys found the seeded session):

```
🌐 Keep-alive server listening on port 3000
🔌 Menghubungkan ke WhatsApp...
📇 Seeded lid from creds: 125812544147601@lid
✅ WhatsApp berhasil terhubung!
```

**Bad sign** (the seed went wrong — stop immediately):

```
📱 SCAN QR INI...
<big QR art>
```

If you see the QR, do this:

```powershell
# Stop the current machine so it does not burn through reconnect attempts.
flyctl machine list --app $APP
flyctl machine stop <machine-id> --app $APP

# Re-verify / re-upload the session per step 5 and 6,
# then restart the machine:
flyctl machine start <machine-id> --app $APP
# or, if you changed the image:
flyctl deploy --app $APP
```

Do **not** just scan the QR on the first machine with a fresh device — it will unlink your existing WhatsApp session and you will have to re-authenticate on your phone.

---

## 10. Cost expectations

- `shared-cpu-1x`, 512MB, in `sin`, running 24/7 (`min_machines_running = 1`): roughly **$2/month**.
- 1GB persistent volume in `sin`: roughly **$0.15/month**.
- Outbound bandwidth for a WhatsApp bot is negligible (a few MB/month).

Total: budget ~$2–3/month. Configure a payment method via the Fly web dashboard (`Organizations` → your org → `Billing`) or check with `flyctl orgs show`.

---

## 11. Session portability caveat

WhatsApp sometimes force-logs-out a linked device when its source IP changes region abruptly. `sin` (Singapore) is geographically close to most Asian hosting (Replit, typical VPS), so the risk is low but non-zero. Two mitigations:

- Download your Baileys session from the old host and upload + deploy to Fly in the same sitting — do not leave a multi-day gap.
- If WhatsApp does log the device out, you will need to log out manually on your phone and re-link by scanning a QR. The only way to scan a QR on Fly is to run the container temporarily with stdout attached (`flyctl machine run <image> --it -- node index.js`) — it is painful, hence the emphasis on seeding the volume correctly.

---

## 12. Day-2 operations cheatsheet

```powershell
# Stream logs (Ctrl-C to exit)
flyctl logs -a $APP

# Current machine health + IPs
flyctl status -a $APP

# Shell inside the running container
flyctl ssh console -a $APP

# Redeploy after pushing new code to master
flyctl deploy -a $APP

# Rotate a secret (triggers an automatic restart)
flyctl secrets set SPREADSHEET_ID="new_value" -a $APP

# Remove a secret (also triggers restart)
flyctl secrets unset APPROVER_LABEL -a $APP

# List current secret names (values are never shown)
flyctl secrets list -a $APP
```

---

## 13. Scaling memory

If you decide 512MB is overkill and want to save a dollar a month:

```powershell
flyctl scale memory 256 -a $APP
```

Keep an eye on `flyctl logs` during sticker conversions (`!stiker` / `!damn`). sharp + ffmpeg together can spike memory during a video-to-sticker transcode; if the container OOM-restarts, scale back up to 512MB:

```powershell
flyctl scale memory 512 -a $APP
```

---

## Appendix: what lives where

| Variable | Kind | Where it is set | Value on Fly |
| --- | --- | --- | --- |
| `NODE_ENV` | non-secret | `fly.toml [env]` | `production` |
| `TZ` | non-secret | `fly.toml [env]` | `Asia/Jakarta` |
| `AUTH_DIR` | path, non-secret | `fly.toml [env]` | `/data/auth_info_baileys` |
| `REACTION_MAP_PATH` | path, non-secret | `fly.toml [env]` | `/data/reactionMap.json` |
| `DAMN_STICKER_PATH` | path, non-secret | `fly.toml [env]` | `/data/damn.webp` |
| `GOOGLE_CREDENTIALS_PATH` | path, non-secret | `fly.toml [env]` | `/data/credentials.json` |
| `SPREADSHEET_ID` | secret | `flyctl secrets set` | your spreadsheet ID |
| `SHEET_REMINDER_TAB` | secret | `flyctl secrets set` | `Reminders` |
| `SHEET_MANUAL_TAB` | secret | `flyctl secrets set` | `MyReminders` |
| `SHEET_OVERRIDE_TAB` | secret | `flyctl secrets set` | `BotOverrides` |
| `OWNER_NUMBER` | secret | `flyctl secrets set` | `628xxx` |
| `ALLOWED_NUMBERS` | secret | `flyctl secrets set` | comma-separated |
| `ALLOWED_LIDS` | secret | `flyctl secrets set` | e.g. `125812544147601` |
| `DEFAULT_GROUP_JID` | secret | `flyctl secrets set` | `120363xxx@g.us` |
| `REMINDER_CRON` | secret | `flyctl secrets set` | `0 8 * * *` |
| `NOTIFY_DAYS_BEFORE` | secret | `flyctl secrets set` | `7,3,1,0` |
| `NUMBER_NAME_MAP` | secret | `flyctl secrets set` | `628xxx=Alice,...` |
| `DONE_REQUIRE_OWNER_APPROVAL` | secret (optional) | `flyctl secrets set` | `false` |
| `DONE_APPROVAL_TTL_MS` | secret (optional) | `flyctl secrets set` | `900000` |
| `APPROVER_NUMBERS` | secret (optional) | `flyctl secrets set` | `OWNER_NUMBER,...` |
| `APPROVER_LABEL` | secret (optional) | `flyctl secrets set` | `Abang` |
| `auth_info_baileys/` | session files | SFTP to volume | `/data/auth_info_baileys/` |
| `credentials.json` | Google key | SFTP to volume | `/data/credentials.json` |
| `damn.webp` | sticker | SFTP to volume | `/data/damn.webp` |
| `reactionMap.json` | runtime state | created by bot | `/data/reactionMap.json` |
