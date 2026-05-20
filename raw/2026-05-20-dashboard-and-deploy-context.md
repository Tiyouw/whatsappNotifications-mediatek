---
source: codex_session
captured_at: 2026-05-20
contributor: Codex
project: wa-reminder-bot
---

# Dashboard And Deploy Context

This note captures project context from the May 2026 Codex session so future graphify runs can preserve the architecture decisions, operational discoveries, and recent implementation work.

## Project State

The project is a WhatsApp reminder bot named Reo'sBot, deployed on Fly.io as `reo-on-cavern`. The bot uses Baileys for WhatsApp, Google Sheets as the reminder source, and a persistent Fly volume at `/data` for WhatsApp session state, Google credentials, sticker assets, and reaction map state.

The root Fly app now serves a built-in lightweight dashboard at:

```text
https://reo-on-cavern.fly.dev/
```

The dashboard is served directly by `index.js` through `src/dashboardServer.js` on port `3000`; it does not use the older separate Next.js dashboard in `dashboard/`.

## Recent Commits

- `ca01c55 Support sticker replies and update docs`
- `db13945 Add Fly dashboard for reminders and stickers`

## Important Behavior Decisions

Auto-import reminders from the `Reminders` sheet are intentionally editable by the bot for allowed users. Documentation was corrected because the previous wording incorrectly described auto-import rows as read-only from bot commands. Authorized/admin/owner users can mark auto-import reminders done via `!done` or by reacting ✅ to reminder messages.

The `!sticker` command now supports both expected flows:

- send image/video with caption `!sticker`
- reply to an image/video with `!sticker`

The reply flow reuses quoted-message reconstruction similar to `!setdamn`, then uses the existing sticker conversion pipeline.

## Built-In Dashboard

The dashboard is a small single-page app with static assets:

- `public/dashboard.html`
- `public/dashboard.css`
- `public/dashboard.js`

The HTTP/API server lives in:

- `src/dashboardServer.js`

The dashboard title and brand are `ReoOnCavern`. It uses the Urbanist font.

Dashboard navigation:

1. Dashboard
2. Stickers
3. Reminders
4. Logout

Dashboard capabilities:

- view all reminders, including `active`, `done`, and `skip`
- view upcoming reminders in the dashboard overview
- use paginated full reminder list in the Reminders tab
- filter by all, active, done, and overdue
- create reminders into `MyReminders`
- mark reminders as done
- skip reminders
- trigger Send Due and Weekly Summary from hoverable action cards
- show confirmation prompts before dangerous/send actions
- show darker visual styling for done/skipped reminders
- preview current `!damn` sticker
- upload image/video to update `!damn`
- send `!damn` sticker to owner or a target number/group JID

Dashboard API authentication uses `DASHBOARD_TOKEN` or `API_SECRET`. Pasted token values from chat should not be stored in documentation or graph context; rotate dashboard secrets whenever they are exposed in a chat log.

## Dashboard API Routes

The dashboard server exposes:

- `GET /` and `GET /dashboard`: dashboard HTML
- `GET /dashboard.css`: dashboard CSS
- `GET /dashboard.js`: dashboard JavaScript
- `GET /health`: plain health response
- `GET /api/dashboard/config`: dashboard auth/config status
- `GET /api/reminders`: all reminders, including inactive rows
- `POST /api/reminders`: create a manual reminder
- `POST /api/reminders/:globalNo/done`: mark reminder done
- `POST /api/reminders/:globalNo/skip`: mark reminder skipped
- `POST /api/actions/send-due`: trigger due reminders
- `POST /api/actions/weekly-summary`: send weekly summary
- `GET /api/stickers/damn`: current `!damn` sticker as WebP
- `POST /api/stickers/damn`: update `!damn` sticker from uploaded media
- `POST /api/stickers/damn/send`: send `!damn` sticker to owner or target

## Google Sheets Change

`src/sheets.js` now supports:

```js
getReminders({ includeInactive: true })
```

This allows the dashboard to show `done` and `skip` reminders while preserving the bot's default active-only behavior for reminder sends and normal command flows.

## Fly.io Routing Discovery

The Fly app existed and the machine was healthy, but `reo-on-cavern.fly.dev` initially returned `DNS_PROBE_FINISHED_NXDOMAIN` because no public IP was assigned.

Fix:

```powershell
flyctl ips allocate-v4 --shared --app reo-on-cavern
flyctl ips allocate-v6 --app reo-on-cavern
```

After IP allocation, DNS resolved to both:

- IPv4 shared ingress
- IPv6 Fly address

`curl -v https://reo-on-cavern.fly.dev/` returned `HTTP/1.1 200 OK` and served dashboard HTML.

The user could also access the app through:

```powershell
flyctl proxy 3001:3000 --app reo-on-cavern
```

and then:

```text
http://127.0.0.1:3001/
```

This confirmed the dashboard worked internally before public ingress was fixed. The proxy route is private WireGuard/local tunneling and bypasses public Fly ingress.

## Deployment Commands

Set or rotate dashboard token:

```powershell
flyctl secrets set DASHBOARD_TOKEN="new-token-here" --app reo-on-cavern
```

Deploy:

```powershell
flyctl deploy --app reo-on-cavern
```

Check app:

```powershell
flyctl status --app reo-on-cavern
flyctl logs --app reo-on-cavern --no-tail
flyctl services list --app reo-on-cavern
flyctl ips list --app reo-on-cavern
```

Public URL:

```text
https://reo-on-cavern.fly.dev/
```

## Files Changed In The Dashboard Work

- `index.js`
- `src/dashboardServer.js`
- `src/sheets.js`
- `public/dashboard.html`
- `public/dashboard.css`
- `public/dashboard.js`
- `.dockerignore`
- `.env.example`
- `fly.toml`
- `README.md`
- `DEPLOYMENT.md`

## Security Notes

Do not commit:

- `.env`
- `credentials.json`
- `auth_info_baileys/`
- runtime logs
- dashboard token values pasted in chat

If a dashboard token is pasted into chat, rotate it with `flyctl secrets set DASHBOARD_TOKEN="..." --app reo-on-cavern`.
