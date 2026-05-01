# 🤖 Reo'sBot — WhatsApp Reminder Bot

Bot WhatsApp personal untuk reminder deadline dari Google Sheets, sticker converter, dan manajemen task via chat.

---

## 📦 Tech Stack

| Library | Fungsi |
|---|---|
| `@whiskeysockets/baileys` | WhatsApp Web API |
| `googleapis` | Google Sheets read/write |
| `node-cron` | Scheduler otomatis |
| `sharp` | Convert gambar → sticker WebP |
| `fluent-ffmpeg` | Convert video → animated sticker WebP |
| `dayjs` | Date parsing & formatting |
| `qrcode-terminal` | Tampilkan QR scan di terminal |
| `dotenv` | Konfigurasi environment |

---

## 🚀 Setup Awal

### 1. Install Node.js
Download **Node.js LTS** di [nodejs.org](https://nodejs.org). Minimal versi 18.

### 2. Install ffmpeg
Download di [ffmpeg.org](https://ffmpeg.org/download.html) lalu tambahkan ke PATH.
Cek: `ffmpeg -version`

### 3. Install dependencies
```bash
npm install
```

### 4. Setup Google Sheets API

**A. Google Cloud Project**
1. Buka [console.cloud.google.com](https://console.cloud.google.com)
2. Buat project baru → Enable **Google Sheets API**
3. **Credentials** → **Create Credentials** → **Service Account**
4. Di service account → tab **Keys** → **Add Key** → **JSON**
5. Download → rename jadi `credentials.json` → taruh di root folder project

**B. Buat Google Sheet**

Buat 2 tab di spreadsheet:

**Tab `Reminders`** ← ImportRange dari sheet HUMAS (read-only, tidak bisa !done/!edit/!hapus)

**Tab `MyReminders`** ← Ditulis bot via `!tambah`

Header kedua tab harus sama persis (baris 1):

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| No | Nama Task | Deadline | Target | H-Notif | Catatan | Status |

**C. Share spreadsheet ke service account**
- Buka file `credentials.json` → cari field `client_email`
- Share spreadsheet ke email tersebut dengan akses **Editor**

**D. Ambil Spreadsheet ID**
```
https://docs.google.com/spreadsheets/d/[SPREADSHEET_ID]/edit
```

### 5. Konfigurasi `.env`
```bash
cp .env.example .env
```

Isi file `.env`:
```env
# Google Sheets
SPREADSHEET_ID=your_spreadsheet_id_here
GOOGLE_CREDENTIALS_PATH=./credentials.json
SHEET_REMINDER_TAB=Reminders
SHEET_MANUAL_TAB=MyReminders

# WhatsApp
OWNER_NUMBER=628xxxxxxxxxx

# Nomor yang boleh akses bot (pisah koma, termasuk OWNER_NUMBER)
ALLOWED_NUMBERS=628xxxxxxxxxx,628nomorteman1,628nomorteman2

# Default target jika kolom Target di Sheet kosong
DEFAULT_GROUP_JID=120363xxxxxxxxxx@g.us

# Scheduler (cron expression, timezone Asia/Jakarta)
REMINDER_CRON=0 8 * * *

# H- berapa hari sebelum deadline default (jika kolom H-Notif kosong)
NOTIFY_DAYS_BEFORE=7,3,1,0
```

### 6. Jalankan Bot
```bash
npm start        # production
npm run dev      # development (auto-restart saat file berubah)
```

Scan QR yang muncul di terminal dengan WhatsApp nomor kedua:
**WhatsApp → Linked Devices → Link a Device**

---

## 📱 Commands

### Reminder

| Command | Deskripsi |
|---|---|
| `!cek` | Tampilkan reminder aktif sesuai konteks (grup/pribadi) |
| `!cek semua` | Tampilkan semua reminder (hanya dari chat pribadi) |
| `!cek grup` | Tampilkan semua reminder bertarget grup |
| `!hari` | Reminder yang jatuh tempo hari ini |
| `!kirim` | Trigger kirim reminder sekarang tanpa nunggu jadwal |
| `!done [no]` | Tandai reminder selesai |
| `!tambah` | Panduan tambah reminder baru |
| `!edit [no] [field] [nilai]` | Ubah satu field reminder |
| `!hapus [no]` | Hapus reminder |
| `!summary` | Ringkasan semua reminder aktif |

### Format `!tambah`
```
!tambah [task] | [deadline] | [H-notif] | [catatan]
```
- **Deadline**: format `YYYY-MM-DD`
- **H-notif**: `7,3,1,0` = kirim di H-7, H-3, H-1, dan hari H
- **Target**: otomatis — grup jika dari grup, nomor sendiri jika dari chat pribadi
- Disimpan ke tab `MyReminders`

Contoh:
```
!tambah Laporan Bulanan | 2026-05-31 | 7,3,1,0 | Kirim ke email ketua
!tambah Rapat Divisi | 2026-05-15 | 1,0 | Di aula utama
```

### Format `!edit`
```
!edit [no] [field] [nilai baru]
```

Field yang tersedia:
| Field | Alias | Keterangan |
|---|---|---|
| `task` | `nama` | Nama tugas |
| `deadline` | `tanggal` | Format YYYY-MM-DD |
| `notif` | — | Contoh: `3,1,0` |
| `catatan` | `notes` | Teks bebas |

Contoh:
```
!edit 3 task Laporan Akhir Semester
!edit 3 deadline 2026-06-01
!edit 3 notif 7,3,1,0
!edit 3 catatan Kirim via email ke dosen
```

### Info

| Command | Deskripsi |
|---|---|
| `!status` | Uptime bot, jumlah reminder aktif, jadwal cron |
| `!help` | Tampilkan semua command |

---

## 🎨 Sticker

| Konteks | Cara Pakai |
|---|---|
| Chat pribadi ke bot | Kirim gambar/video → otomatis jadi sticker |
| Di grup | Kirim gambar/video dengan caption `!sticker` |

- **Gambar**: JPG, PNG → sticker WebP 512x512
- **Video**: MP4, WebM → animated sticker WebP, max 10 detik

---

## ⏰ Scheduler Otomatis

| Jadwal | Aksi |
|---|---|
| Setiap hari jam 08:00 WIB (default) | Kirim reminder yang due hari ini ke target masing-masing |
| Setiap Senin jam 07:00 WIB | Weekly summary ke OWNER_NUMBER |

**Cron expression** di `.env`:
| Expression | Artinya |
|---|---|
| `0 8 * * *` | Setiap hari jam 08:00 |
| `30 9 * * *` | Setiap hari jam 09:30 |
| `0 8 * * 1-5` | Hari kerja jam 08:00 |
| `*/2 * * * *` | Setiap 2 menit (untuk testing) |

---

## 📊 Struktur Google Sheet

### Tab `Reminders` (auto-import / read-only dari bot)
Data dari ImportRange sheet lain. Bot membaca tapi tidak bisa menulis.
- Baris pembatas bulan (MEI, APRIL, dll) otomatis di-skip
- Kolom Target kosong → pakai `DEFAULT_GROUP_JID`
- Kolom Status kosong → dianggap `active`

### Tab `MyReminders` (writable via `!tambah`)
Data yang ditambah lewat bot. Bisa di-`!done`, `!edit`, `!hapus`.

**Format nilai kolom:**

| Kolom | Format | Contoh |
|---|---|---|
| No | Angka | `1` |
| Nama Task | Teks | `Laporan Bulanan` |
| Deadline | YYYY-MM-DD | `2026-05-31` |
| Target | Nomor/JID/kosong | `628xxx`, `120363xxx@g.us`, *(kosong)* |
| H-Notif | Angka pisah koma | `7,3,1,0` |
| Catatan | Teks/mention | `@628xxx segera kerjakan` |
| Status | `active`/`done`/`skip` | `active` |

### Mention di Kolom Catatan
Tulis `@628xxxxxxxxxx` di kolom Catatan → bot akan mention orang tersebut di WhatsApp saat mengirim reminder.

```
@6282132341102 tolong segera kerjakan!
```

---

## 🔒 Akses & Keamanan

- Hanya nomor di `ALLOWED_NUMBERS` yang bisa pakai bot
- Reminder dari tab `Reminders` (auto-import) bersifat **read-only** — tidak bisa di-`!done`, `!edit`, atau `!hapus` dari bot
- Bot tidak akan merespons pesan dari nomor yang tidak terdaftar

---

## ⚠️ Catatan Overdue

Reminder yang sudah lewat deadline tapi belum di-`!done` akan tetap muncul di reminder harian sampai **maksimal 7 hari** setelah deadline dengan label 🔴 "Telat X hari!". Setelah 7 hari berhenti otomatis.

---

## 🔧 Jalankan Permanen dengan PM2

Agar bot tetap jalan meski terminal ditutup atau laptop restart:

```bash
npm install -g pm2
pm2 start index.js --name reos-bot
pm2 save
pm2 startup   # ikuti instruksi yang muncul
```

Command PM2 berguna:
```bash
pm2 status          # cek status
pm2 logs reos-bot   # lihat log
pm2 restart reos-bot
pm2 stop reos-bot
```

---

## 📁 Struktur Project

```
wa-reminder-bot/
├── index.js                  # Entry point, koneksi Baileys
├── .env                      # Konfigurasi (jangan di-commit!)
├── .env.example              # Template konfigurasi
├── credentials.json          # Google Service Account (jangan di-commit!)
├── package.json
├── auth_info_baileys/        # Session WhatsApp (auto-generated)
└── src/
    ├── sheets.js             # Google Sheets read/write
    ├── scheduler.js          # Cron job harian & weekly summary
    ├── reminder.js           # Format pesan & helper
    ├── commandHandler.js     # Handler semua command WhatsApp
    └── stickerHandler.js     # Convert gambar/video → sticker
```

---

## 🛠️ Troubleshooting

| Masalah | Solusi |
|---|---|
| QR tidak muncul | Pastikan `printQRInTerminal` tidak ada di config |
| Bot tidak respon | Cek `ALLOWED_NUMBERS` di `.env` |
| Error Sheets | Pastikan spreadsheet di-share ke email service account |
| `Bad MAC error` | Hapus `auth_info_baileys/`, scan QR ulang |
| Sticker video gagal | Pastikan ffmpeg terinstall dan ada di PATH |
| Bot kirim "aktif" berkali-kali | Sudah teratasi dengan flag `isFirstConnect` |
| Scheduler dobel | Sudah teratasi dengan flag `schedulerStarted` |
| Reminder tidak terkirim jam 8 | Cek apakah laptop sleep — nonaktifkan sleep mode |

---

## 🗂️ .gitignore

```
node_modules/
auth_info_baileys/
credentials.json
.env
*.log
```