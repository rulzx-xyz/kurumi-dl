// server.js
// Backend kecil buat KURUMI DL — nerima link dari frontend, terusin ke instance
// cobalt (https://github.com/imputnet/cobalt) via REST API, balikin link file bersih.
//
// INI BUKAN SCRAPER. cobalt punya REST API resmi yang memang didesain untuk ini,
// jadi kita tinggal "nembak" endpoint-nya — bukan reverse-engineer TikTok/IG/YouTube.

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Muat .env cuma kalau filenya ada (misal di Termux). Di platform seperti
// Railway, environment variable sudah di-inject langsung, jadi gak butuh file.
(function loadEnvFile(){
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serves public/index.html

const PORT = process.env.PORT || 3000;

// ---------- login admin (khusus developer, buka Ruang Kontrol) ----------
// GANTI username & password ini di file .env kamu, jangan pakai default!
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

// Token dibuat ulang tiap server restart — jadi admin perlu login ulang kalau
// server di-restart (aman, karena bukan disimpan permanen di file).
const ADMIN_TOKEN = crypto.randomBytes(24).toString('hex');

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Sesi admin tidak valid, silakan login ulang.' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return res.json({ ok: true, token: ADMIN_TOKEN });
  }
  return res.status(401).json({ ok: false, error: 'Username atau password salah.' });
});

// ---------- penyimpanan permanen (file JSON kecil, bukan cuma di memori) ----------
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return { history: [], reviews: [] };
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Rating & ulasan tetap publik — semua pengunjung boleh lihat siapa yang kasih rating
app.get('/api/reviews', (_req, res) => {
  const data = loadData();
  res.json({ ok: true, reviews: data.reviews });
});

// Riwayat unduhan (siapa download apa) — HANYA admin yang boleh lihat
app.get('/api/admin/history', requireAdmin, (_req, res) => {
  const data = loadData();
  res.json({ ok: true, history: data.history });
});

app.post('/api/reviews', (req, res) => {
  const { stars, text, name } = req.body;
  if (!stars || !text) {
    return res.status(400).json({ ok: false, error: 'Rating & ulasan wajib diisi.' });
  }
  const data = loadData();
  data.reviews.unshift({ stars, text, name: name || 'Anonim', time: new Date().toLocaleDateString('id-ID') });
  saveData(data);
  res.json({ ok: true, reviews: data.reviews });
});

// Alamat instance cobalt kamu sendiri (WAJIB self-host, jangan pakai api.cobalt.tools
// publik untuk project ini — instance publik pakai bot-protection dan tidak boleh
// dipakai project luar tanpa izin).
const COBALT_API_URL = process.env.COBALT_API_URL || 'http://localhost:9000';

// Kalau instance cobalt kamu diset pakai API key (disarankan), isi di .env
const COBALT_API_KEY = process.env.COBALT_API_KEY || '';

app.post('/api/download', async (req, res) => {
  const { url, mode, platform, name } = req.body; // mode opsional: "auto" | "audio" | "mute"

  if (!url) {
    return res.status(400).json({ ok: false, error: 'Link tidak boleh kosong.' });
  }

  try {
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
    if (COBALT_API_KEY) headers['Authorization'] = `Api-Key ${COBALT_API_KEY}`;

    const cobaltRes = await fetch(COBALT_API_URL + '/', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url,
        downloadMode: mode || 'auto', // auto = video, audio = audio only, mute = video tanpa suara
        filenameStyle: 'pretty',
        videoQuality: 'max',      // minta kualitas video setinggi mungkin yang tersedia
        youtubeBetterAudio: true, // prioritaskan audio kualitas lebih tinggi dari YouTube
        allowH265: true,          // izinkan H265/HEVC dari TikTok (biasanya kualitas lebih baik)
        tiktokFullAudio: true,
      }),
    });

    const data = await cobaltRes.json();

    switch (data.status) {
      case 'tunnel':
      case 'redirect': {
        const store = loadData();
        store.history.unshift({ url, platform: platform || null, name: name || 'Anonim', time: new Date().toLocaleTimeString('id-ID') });
        store.history = store.history.slice(0, 50);
        saveData(store);
        return res.json({ ok: true, type: 'file', url: data.url, filename: data.filename });
      }

      case 'picker':
        // konten dengan banyak item, misal carousel/slideshow — kirim semua opsinya
        return res.json({ ok: true, type: 'picker', items: data.picker, audio: data.audio || null });

      case 'local-processing':
        return res.json({ ok: true, type: 'local-processing', tunnels: data.tunnel, output: data.output });

      case 'error':
      default:
        return res.status(422).json({ ok: false, error: data.error?.code || 'Gagal memproses link.' });
    }
  } catch (err) {
    console.error('[cobalt] request failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Tidak bisa menghubungi server pemroses. Cek apakah instance cobalt aktif.' });
  }
});

app.get('/health', (_req, res) => res.send('KURUMI DL backend aktif ✅'));

app.listen(PORT, () => console.log(`Buka http://localhost:${PORT} di browser HP kamu`));
