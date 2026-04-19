# 🤖 WA Reminder Bot

Bot WhatsApp personal untuk reminder deadline dari Google Sheets, menggunakan Baileys.

---

## 📋 Fitur

- ✅ Reminder otomatis dari Google Sheets setiap hari (jam 08:00 WIB)
- ✅ Kirim ke nomor personal atau grup WhatsApp
- ✅ Notifikasi di H-7, H-3, H-1, dan H-0 (konfigurasi per task)
- ✅ Weekly summary setiap Senin pagi
- ✅ Command via WhatsApp: `!cek`, `!done`, `!tambah`, dll
- ✅ Auto-reconnect jika koneksi terputus

---

## 🚀 Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Google Sheets API

**A. Buat Google Cloud Project**
1. Buka [console.cloud.google.com](https://console.cloud.google.com)
2. Buat project baru → Enable **Google Sheets API**
3. Buka **Credentials** → **Create Credentials** → **Service Account**
4. Beri nama (contoh: `reminder-bot`), klik Create
5. Di halaman Service Account → **Keys** → **Add Key** → **JSON**
6. Download file JSON → rename ke `credentials.json` → taruh di folder project

**B. Buat Google Sheet**
1. Buat spreadsheet baru di Google Sheets
2. Rename tab pertama menjadi `Reminders`
3. **Share spreadsheet** ke email service account (ada di file credentials.json, field `client_email`)
   → Berikan akses **Editor**
4. Buat header di baris pertama:

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| No | Nama Task | Deadline | Target | H-Notif | Catatan | Status |

**C. Contoh data Sheet:**

| No | Nama Task | Deadline | Target | H-Notif | Catatan | Status |
|---|---|---|---|---|---|---|
| 1 | Laporan Bulanan | 2025-01-31 | 628xxxxxxxxxx | 7,3,1,0 | Kirim ke atasan | active |
| 2 | Bayar Tagihan | 2025-01-20 | | 3,1,0 | | active |
| 3 | Meeting Tim | 2025-02-05 | 120363xxx@g.us | 1,0 | Siapkan presentasi | active |

- **Target kosong** = kirim ke OWNER_NUMBER (kamu sendiri)
- **Target nomor** = kirim ke nomor HP (628xxx)
- **Target @g.us** = kirim ke grup (cara dapat JID grup: lihat langkah di bawah)

### 3. Konfigurasi .env

```bash
cp .env.example .env
```

Edit `.env`:

```env
SPREADSHEET_ID=your_spreadsheet_id_here
GOOGLE_CREDENTIALS_PATH=./credentials.json
SHEET_REMINDER_TAB=Reminders

OWNER_NUMBER=628xxxxxxxxxx

REMINDER_CRON=0 8 * * *
NOTIFY_DAYS_BEFORE=7,3,1,0
```

> **Cara dapat SPREADSHEET_ID:** Lihat URL spreadsheet kamu:
> `https://docs.google.com/spreadsheets/d/`**`YOUR_SPREADSHEET_ID`**`/edit`

### 4. Jalankan Bot

```bash
npm start
```

Pertama kali jalan, akan muncul QR code di terminal. Scan dengan nomor kedua kamu:
- WhatsApp → **Linked Devices** → **Link a Device** → Scan QR

Setelah scan, bot akan aktif dan kamu menerima pesan konfirmasi.

---

## 📱 Commands

| Command | Fungsi |
|---|---|
| `!help` | Tampilkan daftar perintah |
| `!cek` | Lihat semua reminder aktif |
| `!hari` | Lihat reminder yang due hari ini |
| `!kirim` | Trigger kirim reminder sekarang |
| `!done [no]` | Tandai reminder selesai |
| `!damn` | Kirim sticker pilihan |
| `!setdamn` | Set sticker untuk `!damn` (reply sticker/gambar) |
| `!tambah` | Panduan tambah reminder via WA |
| `!status` | Info bot, uptime, jumlah reminder |

### Contoh `!tambah`:
```
!tambah Laporan Q1 | 2025-03-31 | 628xxxxxxxxxx | 7,3,1,0 | Kirim ke email direktur
```

---

## 🔍 Cara Dapat Group JID

Untuk kirim ke grup, kamu butuh JID grup (format: `120363xxx@g.us`).

**Cara mudah:**
1. Jalankan bot
2. Kirim sembarang pesan ke grup dari nomor personal kamu (bukan nomor bot)
3. Cek log terminal bot — akan tampil JID grup:
   ```
   📥 Incoming message from 120363xxx@g.us
   ```
4. Gunakan JID itu di kolom Target di Sheet

---

## 🔧 Cron Expression

Format: `menit jam hari-bulan bulan hari-minggu`

| Expression | Artinya |
|---|---|
| `0 8 * * *` | Setiap hari jam 08:00 |
| `0 8,12 * * *` | Jam 08:00 dan 12:00 |
| `0 8 * * 1-5` | Hari kerja jam 08:00 |
| `0 9 * * 1` | Setiap Senin jam 09:00 |

---

## 📁 Struktur Folder

```
wa-reminder-bot/
├── index.js              # Entry point
├── .env                  # Konfigurasi (jangan di-commit!)
├── credentials.json      # Google Service Account (jangan di-commit!)
├── package.json
├── auth_info_baileys/    # Session WA (auto-generated, jangan dihapus)
└── src/
    ├── sheets.js         # Google Sheets integration
    ├── scheduler.js      # Cron job
    ├── reminder.js       # Formatting & helper
    └── commandHandler.js # WhatsApp command handler
```

---

## ⚠️ Catatan Penting

- Jangan hapus folder `auth_info_baileys/` — ini menyimpan sesi WhatsApp kamu
- Jangan commit `credentials.json` dan `.env` ke Git
- Baileys adalah unofficial API. Gunakan untuk keperluan personal, bukan spam
- Laptop/PC harus menyala agar bot berjalan (atau gunakan PM2 agar restart otomatis)

### Jalankan dengan PM2 (agar auto-restart jika crash):
```bash
npm install -g pm2
pm2 start index.js --name reminder-bot
pm2 save
pm2 startup  # agar auto-start saat laptop restart
```

---

## 🪟 Auto-Start di Windows (Service / On Boot)

Kalau kamu mau bot jalan otomatis tanpa buka VSCode dan bisa auto-start saat Windows boot, pakai **Windows Service** (via NSSM).

### 1) Pairing sekali (wajib)
Jalankan bot normal dulu supaya bisa scan QR:
```bash
npm start
```
Setelah berhasil connect dan folder `auth_info_baileys/` terisi, stop (Ctrl+C).

### 2) Install NSSM (sekali)
```bash
winget install --id NSSM.NSSM -e --scope user --silent --accept-package-agreements --accept-source-agreements
```

### 3) Install Service (Run as Administrator)
Buka PowerShell / Terminal **Run as Administrator**, lalu:
```bash
npm run service:install
```

Log file:
- `logs/out.log`
- `logs/err.log`

### (Opsional) Approval untuk !done dari non-owner
Kalau kamu ingin user di `ALLOWED_NUMBERS` boleh kirim `!done`, tapi status *baru berubah setelah Abang approve*, set env:
```env
DONE_REQUIRE_OWNER_APPROVAL=true
DONE_APPROVAL_TTL_MS=900000
SHEET_OVERRIDE_TAB=BotOverrides
APPROVER_NUMBERS=OWNER_NUMBER,62xxxxxxxxxx,62yyyyyyyyyy
APPROVER_LABEL=Abang
NUMBER_NAME_MAP=62xxxxxxxxxx=Ahmad,62yyyyyyyyyy=Almas,62zzzzzzzzzz=Ahimsa
```

Catatan kolom sheet:
- Bot mencari header kolom `Status` dan `Approval` di baris 1 (posisinya bebas, tidak harus kolom G/H).
- Saat `done`, bot akan isi `Status=done` dan `Approval=<nama approver>`.

Bot akan kirim request ke Abang (semua nomor di `APPROVER_NUMBERS`) dan Abang bisa balas:
- `!approve [code]`
- `!reject [code]`

### Uninstall Service
(Run as Administrator)
```bash
npm run service:uninstall
```

---

## 🆕 Pengembangan Selanjutnya

- [ ] Modul keuangan (catat pengeluaran/pemasukan via WA)
- [ ] Backup reminder ke Sheets jika status berubah
- [ ] Notifikasi via gambar/dokumen
- [ ] Multi-sheet untuk kategori berbeda
