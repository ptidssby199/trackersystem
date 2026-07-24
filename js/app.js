/**
 * app.js — application shell, routing and page logic for IDS Tracker System
 */

// ---------------------------------------------------------------
// State & utilities
// ---------------------------------------------------------------
const State = {
  user: null,
  page: 'record',
  petaniCache: [],
  typeCache: [],
  gps: null, // { lat, lng }
  editingPetani: null,
  editingType: null,
  editingEmployee: null,
  map: null,
  marker: null,
  notifications: [], // { msg, kind, time }
};

let deferredInstallPrompt = null;

function toast(msg, kind = '') {
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3800);
  addNotification(msg, kind || 'info');
}

// ---------------------------------------------------------------
// Notification center (custom in-app notifications, with a native
// OS notification fallback when the app is running in the
// background as an installed PWA).
// ---------------------------------------------------------------
function addNotification(msg, kind) {
  State.notifications.unshift({ msg, kind, time: new Date() });
  State.notifications = State.notifications.slice(0, 30);
  renderNotifList();

  const dot = document.getElementById('notifDot');
  if (dot) dot.classList.remove('hidden');

  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('IDS Tracker System', {
        body: msg,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
      });
    } catch (_) { /* ignore unsupported environments */ }
  }
}

function renderNotifList() {
  const list = document.getElementById('notifList');
  if (!list) return;
  if (State.notifications.length === 0) {
    list.innerHTML = '<div class="empty-state">Belum ada notifikasi.</div>';
    return;
  }
  const iconFor = (kind) => (kind === 'success' ? '✓' : kind === 'error' ? '!' : '•');
  list.innerHTML = State.notifications.map((n) => `
    <div class="notif-row ${n.kind}">
      <div class="ni-icon">${iconFor(n.kind)}</div>
      <div class="ni-body">
        <div class="ni-msg">${esc(n.msg)}</div>
        <div class="ni-time">${n.time.toLocaleTimeString('id-ID')}</div>
      </div>
    </div>
  `).join('');
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------
// App-wide settings (Source & CropYear) — configured once in the
// Pengaturan menu, then followed everywhere else in the app.
// ---------------------------------------------------------------
async function getAppSettings() {
  const row = await DB.get('config', 'appSettings');
  return row || { key: 'appSettings', source: '', cropYear: '' };
}

async function saveAppSettings(obj) {
  await DB.put('config', { key: 'appSettings', ...obj });
}

// SQL Server datetime string, matching how T_GPS.dtRecord / dtModified /
// Dates actually render, e.g. "2026-07-24 11:41:05.000".
function formatSqlDateTime(d = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// transID in T_GPS is a signed 32-bit SQL "int" (values there run negative
// too, e.g. -2142883594), so generate within the full Int32 range rather
// than a plain positive 10-digit number.
function genTransId(existingIds) {
  let id;
  do {
    id = Math.floor(Math.random() * 4294967296) - 2147483648;
  } while (existingIds && existingIds.has(id));
  return id;
}

// GUID for T_GPS.rowguid, e.g. "869ACB95-7C4F-3AC1-A075-05B503D65EBD".
function genRowGuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID().toUpperCase();
  // Fallback for older browsers without crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  }).toUpperCase();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// r.tanggal / dtRecord / dtModified are stored with millisecond precision
// (to match T_GPS exactly); trim that for a cleaner on-screen display.
function fmtDt(s) {
  return String(s ?? '').replace(/\.\d{3}$/, '');
}

function normalizeConfigKeys(obj) {
  if (obj && obj.firebaseConfig) obj = obj.firebaseConfig;
  if (obj && obj.config) obj = obj.config;
  return obj || {};
}

// Accepts either pure JSON or the JS snippet Firebase Console gives you
// (e.g. `const firebaseConfig = { apiKey: "...", ... };`) and returns
// a plain config object.
function parseFirebaseConfigText(text) {
  try {
    return normalizeConfigKeys(JSON.parse(text));
  } catch (_) { /* fall through to loose-JS parsing */ }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Format file tidak dikenali.');
  }
  let obj = text.slice(start, end + 1);

  obj = obj.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments
  obj = obj.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":'); // quote keys
  obj = obj.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (m, p1) => '"' + p1.replace(/"/g, '\\"') + '"'); // ' -> "
  obj = obj.replace(/,(\s*[}\]])/g, '$1'); // trailing commas

  try {
    return normalizeConfigKeys(JSON.parse(obj));
  } catch (_) {
    throw new Error('Tidak bisa membaca isi file sebagai konfigurasi Firebase.');
  }
}

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  await DB.open();
  await DB.seedIfEmpty();
  bindLogin();
  bindShell();
  registerServiceWorker();

  const savedUser = sessionStorage.getItem('idsTrackerUser');
  if (savedUser) {
    State.user = JSON.parse(savedUser);
    showApp();
  }
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').then((reg) => {
      // If a new version is already installed and waiting, activate it now.
      if (reg.waiting) reg.waiting.postMessage('skipWaiting');
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            newWorker.postMessage('skipWaiting');
          }
        });
      });
    }).catch(() => {
      // Offline install support just won't be available; the app still works online.
    });
  });

  // Once the new service worker takes control, reload once to pick up
  // the fresh app shell (index.html/css/js) instead of stale cached files.
  let refreshedOnce = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshedOnce) return;
    refreshedOnce = true;
    window.location.reload();
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('installBtn');
  if (btn) btn.classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById('installBtn');
  if (btn) btn.classList.add('hidden');
  toast('Aplikasi terpasang di perangkat ini.', 'success');
});

// ---------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------
function bindLogin() {
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('loginId').value.trim();
    const pw = document.getElementById('loginPassword').value;
    const errEl = document.getElementById('loginError');
    errEl.textContent = '';

    const emp = await DB.get('employees', id);
    if (!emp || emp.password !== pw) {
      errEl.textContent = 'ID Pegawai atau password salah.';
      return;
    }
    State.user = { kodenik: emp.kodenik, nama: emp.nama, posisi: emp.posisi };
    sessionStorage.setItem('idsTrackerUser', JSON.stringify(State.user));
    showApp();
  });
}

function bindShell() {
  document.getElementById('logoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem('idsTrackerUser');
    State.user = null;
    document.getElementById('appShell').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('loginForm').reset();
  });

  document.querySelectorAll('.bn-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.bn-item').forEach((n) => n.classList.remove('active'));
      item.classList.add('active');
      State.page = item.dataset.page;
      renderPage();
    });
  });

  // Notification bell panel
  const bellBtn = document.getElementById('notifBellBtn');
  const panel = document.getElementById('notifPanel');
  bellBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      document.getElementById('notifDot').classList.add('hidden');
    }
  });
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== bellBtn) {
      panel.classList.add('hidden');
    }
  });
  document.getElementById('notifClearBtn').addEventListener('click', () => {
    State.notifications = [];
    renderNotifList();
  });

  const enableBtn = document.getElementById('notifEnableBtn');
  if ('Notification' in window && Notification.permission === 'default') {
    enableBtn.classList.remove('hidden');
  }
  enableBtn.addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      enableBtn.classList.add('hidden');
      toast('Notifikasi perangkat diaktifkan.', 'success');
    } else {
      toast('Izin notifikasi tidak diberikan.', 'error');
    }
  });

  // Install button (PWA)
  document.getElementById('installBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById('installBtn').classList.add('hidden');
    if (choice.outcome === 'accepted') toast('Memasang aplikasi…', 'success');
  });
}

function showApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  document.getElementById('userLabel').textContent = `${State.user.nama} · ${State.user.kodenik}`;
  renderPage();
}

// ---------------------------------------------------------------
// Router
// ---------------------------------------------------------------
async function renderPage() {
  const main = document.getElementById('mainContent');
  switch (State.page) {
    case 'record': return renderRecordPage(main);
    case 'petani': return renderPetaniPage(main);
    case 'type': return renderTypePage(main);
    case 'employee': return renderEmployeePage(main);
    case 'setting': return renderSettingPage(main);
    case 'laporan': return renderReportPage(main);
    case 'sync': return renderSyncPage(main);
    case 'backup': return renderBackupPage(main);
    default: main.innerHTML = '<p>Halaman tidak ditemukan.</p>';
  }
}

// ---------------------------------------------------------------
// PAGE: Catat Lokasi (core GPS recording feature)
// ---------------------------------------------------------------
async function renderRecordPage(main) {
  State.petaniCache = await DB.getAll('petani');
  State.typeCache = await DB.getAll('types');
  const records = (await DB.getAll('records')).sort((a, b) => b.id - a.id);
  const settings = await getAppSettings();
  const existingTransIds = new Set(records.map((r) => r.transId).filter((v) => v !== undefined && v !== null));
  const transId = genTransId(existingTransIds);
  const nowLocal = new Date();
  const nowLocalValue = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, '0')}-${String(nowLocal.getDate()).padStart(2, '0')}T${String(nowLocal.getHours()).padStart(2, '0')}:${String(nowLocal.getMinutes()).padStart(2, '0')}`;

  main.innerHTML = `
    <p class="page-eyebrow">Menu 01</p>
    <div class="page-head"><h2>Catat Lokasi Field Petani</h2></div>

    <div class="stat-row">
      <div class="stat-card"><div class="num">${records.length}</div><div class="lbl">Total Titik Tercatat</div></div>
      <div class="stat-card"><div class="num">${records.filter(r => r.syncStatus !== 'synced').length}</div><div class="lbl">Belum Sinkron</div></div>
      <div class="stat-card"><div class="num">${State.petaniCache.length}</div><div class="lbl">Petani Terdaftar</div></div>
    </div>

    <div class="panel">
      <h3>Titik Lokasi Baru</h3>
      <form id="recordForm">
        <div class="grid-2">
          <div class="field">
            <label for="rTanggal">Tanggal &amp; Waktu Kunjungan</label>
            <input type="datetime-local" id="rTanggal" value="${nowLocalValue}" required />
          </div>
          <div class="field">
            <label for="rType">Type</label>
            <select id="rType" required>
              <option value="">Pilih type…</option>
              ${State.typeCache.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field">
          <label for="rPetani">Kode Petani</label>
          <select id="rPetani" required>
            <option value="">Pilih petani…</option>
            ${State.petaniCache.map(p => `<option value="${esc(p.kodePetani)}">${esc(p.kodePetani)} — ${esc(p.namaPetani)}</option>`).join('')}
          </select>
          ${State.petaniCache.length === 0 ? '<div class="hint-text">Belum ada data petani. Tambahkan dulu di menu Master Petani.</div>' : ''}
        </div>

        <div class="grid-2">
          <div class="field">
            <label>Trans ID <span class="hint-inline">(otomatis)</span></label>
            <input type="text" id="rTransId" value="${esc(transId)}" readonly />
          </div>
          <div class="field">
            <label>Crop Year <span class="hint-inline">(dari Pengaturan)</span></label>
            <input type="text" id="rCropYear" value="${esc(settings.cropYear)}" readonly />
          </div>
        </div>
        ${!settings.cropYear ? '<div class="hint-text" style="color:var(--danger);margin-top:-8px;margin-bottom:14px;">Crop Year belum diatur. Isi dulu di menu Pengaturan sebelum menyimpan titik lokasi.</div>' : ''}

        <div class="field">
          <label for="rRemark">Catatan (Remark)</label>
          <input type="text" id="rRemark" placeholder="Opsional — kosongkan jika tidak ada" />
        </div>

        <div class="gps-box">
          <button type="button" class="btn btn-primary" id="btnGetGps">📍 Ambil Lokasi GPS</button>
          <div class="gps-coords" id="gpsCoords">Belum ada koordinat</div>
          <div id="miniMap"></div>
          <div class="hint-text">Geser marker pada peta untuk menyesuaikan titik secara manual bila perlu. Altitude hanya terisi otomatis dari GPS perangkat, bukan dari geser manual.</div>
        </div>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary" id="btnSaveRecord" disabled>Simpan Titik Lokasi</button>
        </div>
      </form>
    </div>

    <div class="panel">
      <h3>Riwayat Titik Terakhir</h3>
      <div class="table-wrap">
        ${records.length === 0 ? '<div class="empty-state">Belum ada titik lokasi tercatat.</div>' : `
        <table>
          <thead><tr><th>Tanggal</th><th>Kode Petani</th><th>Nama Petani</th><th>Type</th><th>Crop Year</th><th>Koordinat</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${records.slice(0, 25).map(r => `
              <tr>
                <td>${esc(fmtDt(r.tanggal))}</td>
                <td>${esc(r.kodePetani)}</td>
                <td>${esc(r.namaPetani)}</td>
                <td><span class="badge ${r.type.toLowerCase() === 'field' ? 'field' : 'warehouse'}">${esc(r.type)}</span></td>
                <td>${esc(r.cropYear || '-')}</td>
                <td style="font-family:var(--mono);font-size:0.78rem">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</td>
                <td><span class="badge ${r.syncStatus === 'synced' ? 'synced' : 'pending'}">${r.syncStatus === 'synced' ? 'Tersinkron' : 'Belum sinkron'}</span></td>
                <td class="table-actions"><button class="btn btn-danger btn-sm" data-del-record="${r.id}">Hapus</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>`}
      </div>
    </div>
  `;

  initMiniMap();

  document.getElementById('btnGetGps').addEventListener('click', captureGps);

  document.getElementById('recordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!State.gps) { toast('Ambil koordinat GPS terlebih dahulu.', 'error'); return; }
    if (!settings.cropYear) { toast('Crop Year belum diatur di menu Pengaturan.', 'error'); return; }
    const kodePetani = document.getElementById('rPetani').value;
    const petani = State.petaniCache.find(p => p.kodePetani === kodePetani);
    const remarkVal = document.getElementById('rRemark').value.trim();
    const visitDate = new Date(document.getElementById('rTanggal').value);
    const now = new Date();
    const record = {
      transId: Number(document.getElementById('rTransId').value),
      rowguid: genRowGuid(),
      tanggal: formatSqlDateTime(visitDate), // maps to T_GPS.Dates
      kodePetani,
      namaPetani: petani ? petani.namaPetani : '', // convenience only, not a T_GPS column
      type: document.getElementById('rType').value, // maps to T_GPS.status
      lat: State.gps.lat,
      lng: State.gps.lng,
      alt: State.gps.alt ?? null,
      cropYear: settings.cropYear,
      source: petani ? petani.source : '',
      supplierConversion: petani ? petani.petaniConversion : '',
      remark: remarkVal || '-',
      userLogin: State.user.kodenik,
      userModified: 'sync',
      username: 'sync',
      dtRecord: formatSqlDateTime(now),
      dtModified: formatSqlDateTime(now),
      syncStatus: 'pending', // local-only flag, not a T_GPS column
      createdAt: now.toISOString(),
    };
    await DB.put('records', record);
    toast('Titik lokasi tersimpan.', 'success');
    renderRecordPage(main);
  });

  main.querySelectorAll('[data-del-record]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus titik lokasi ini?')) return;
      await DB.remove('records', Number(btn.dataset.delRecord));
      toast('Titik lokasi dihapus.');
      renderRecordPage(main);
    });
  });
}

function initMiniMap() {
  const defaultCenter = [-6.2, 106.816]; // Jakarta fallback
  State.map = L.map('miniMap').setView(defaultCenter, 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(State.map);

  State.marker = L.marker(defaultCenter, { draggable: true }).addTo(State.map);
  State.marker.on('dragend', () => {
    const pos = State.marker.getLatLng();
    setGpsValue(pos.lat, pos.lng, State.gps ? State.gps.alt : null);
  });
  State.gps = null;
}

function captureGps() {
  if (!navigator.geolocation) {
    toast('Perangkat ini tidak mendukung GPS.', 'error');
    return;
  }
  const btn = document.getElementById('btnGetGps');
  btn.disabled = true;
  btn.textContent = 'Mencari sinyal GPS…';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, altitude } = pos.coords;
      setGpsValue(latitude, longitude, altitude);
      State.map.setView([latitude, longitude], 17);
      State.marker.setLatLng([latitude, longitude]);
      btn.disabled = false;
      btn.textContent = '📍 Ambil Lokasi GPS';
    },
    (err) => {
      toast('Gagal mengambil lokasi: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = '📍 Ambil Lokasi GPS';
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

function setGpsValue(lat, lng, alt) {
  State.gps = { lat, lng, alt: (alt === null || alt === undefined || Number.isNaN(alt)) ? null : alt };
  const altText = State.gps.alt === null ? 'Alt: -' : `Alt: ${State.gps.alt.toFixed(1)} m`;
  document.getElementById('gpsCoords').textContent = `Lat: ${lat.toFixed(6)}  ·  Lng: ${lng.toFixed(6)}  ·  ${altText}`;
  document.getElementById('btnSaveRecord').disabled = false;
}

// ---------------------------------------------------------------
// PAGE: Laporan Titik Petani
// ---------------------------------------------------------------
async function renderReportPage(main) {
  const allRecords = (await DB.getAll('records')).sort((a, b) => b.id - a.id);
  const petaniList = await DB.getAll('petani');
  const petaniByKode = Object.fromEntries(petaniList.map((p) => [p.kodePetani, p]));
  const sources = [...new Set(petaniList.map((p) => p.source).filter(Boolean))].sort();

  main.innerHTML = `
    <p class="page-eyebrow">Menu 06</p>
    <div class="page-head"><h2>Laporan Titik Petani</h2></div>

    <div class="panel">
      <h3>Filter</h3>
      <div class="grid-2">
        <div class="field">
          <label for="fPetani">Petani</label>
          <select id="fPetani">
            <option value="">Semua Petani</option>
            ${petaniList.map(p => `<option value="${esc(p.kodePetani)}">${esc(p.kodePetani)} — ${esc(p.namaPetani)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="fSource">Source</label>
          <select id="fSource">
            <option value="">Semua Source</option>
            ${sources.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>Peta Titik Lokasi</h3>
      <p class="map-legend">
        <span>🚩 Titik lokasi (saat peta di-zoom dekat)</span>
        <span>🔴 Titik berdekatan (saat peta di-zoom jauh, supaya tidak tumpang tindih)</span>
      </p>
      <div id="reportMap" style="height:400px;border-radius:var(--radius);border:1px solid var(--paper-200);"></div>
      <div class="toolbar" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnExportMapJpeg">🖼 Export Peta (JPEG)</button>
      </div>
    </div>

    <div class="panel">
      <h3>Daftar Titik (<span id="reportCount">0</span>)</h3>
      <div class="toolbar">
        <button class="btn btn-primary" id="btnExportExcel">⬇ Export Excel</button>
      </div>
      <div class="table-wrap" id="reportTableWrap"></div>
    </div>
  `;

  const map = L.map('reportMap').setView([-6.2, 106.816], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
    crossOrigin: true,
  }).addTo(map);
  const markerLayer = L.layerGroup().addTo(map);

  const ZOOM_FLAG_THRESHOLD = 14; // >= this zoom: show flags. Below it: show red dots.

  const flagIcon = L.divIcon({
    html: '🚩',
    className: 'flag-marker',
    iconSize: [24, 24],
    iconAnchor: [3, 22],
    popupAnchor: [4, -20],
  });

  const dotIcon = L.divIcon({
    html: '🔴',
    className: 'dot-marker',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    popupAnchor: [0, -8],
  });

  let currentRows = [];

  function renderTable(rows) {
    document.getElementById('reportCount').textContent = rows.length;
    const wrap = document.getElementById('reportTableWrap');
    if (rows.length === 0) {
      wrap.innerHTML = '<div class="empty-state">Tidak ada titik lokasi yang cocok dengan filter ini.</div>';
      return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Tanggal</th><th>Kode Petani</th><th>Nama Petani</th><th>Type</th><th>Koordinat (Lat, Long, Alt)</th><th>Crop Year</th></tr></thead>
        <tbody>
          ${rows.map(r => {
            const altText = (r.alt === null || r.alt === undefined) ? '-' : `${Number(r.alt).toFixed(1)} m`;
            return `
              <tr>
                <td>${esc(fmtDt(r.tanggal))}</td>
                <td>${esc(r.kodePetani)}</td>
                <td>${esc(r.namaPetani)}</td>
                <td><span class="badge ${r.type.toLowerCase() === 'field' ? 'field' : 'warehouse'}">${esc(r.type)}</span></td>
                <td style="font-family:var(--mono);font-size:0.78rem">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}, ${altText}</td>
                <td>${esc(r.cropYear || '-')}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  function renderMap(rows, opts = {}) {
    markerLayer.clearLayers();
    if (rows.length === 0) return;
    const icon = map.getZoom() >= ZOOM_FLAG_THRESHOLD ? flagIcon : dotIcon;
    const latlngs = [];
    rows.forEach((r) => {
      const p = petaniByKode[r.kodePetani];
      const m = L.marker([r.lat, r.lng], { icon }).addTo(markerLayer);
      m.bindPopup(`
        <strong>${esc(r.kodePetani)} — ${esc(r.namaPetani)}</strong><br/>
        Source: ${esc(p ? p.source : '-')}<br/>
        Type: ${esc(r.type)}<br/>
        Crop Year: ${esc(r.cropYear || '-')}<br/>
        Tanggal: ${esc(fmtDt(r.tanggal))}<br/>
        ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}, Alt: ${(r.alt === null || r.alt === undefined) ? '-' : Number(r.alt).toFixed(1) + ' m'}
      `);
      latlngs.push([r.lat, r.lng]);
    });
    if (opts.keepView) return;
    if (latlngs.length === 1) {
      map.setView(latlngs[0], 15);
    } else {
      map.fitBounds(L.latLngBounds(latlngs), { padding: [30, 30] });
    }
  }

  // Re-pick flag vs red-dot icon whenever the zoom level changes,
  // without re-fitting the view (that would fight the user's zoom/pan).
  map.on('zoomend', () => renderMap(currentRows, { keepView: true }));

  function applyFilters() {
    const petaniVal = document.getElementById('fPetani').value;
    const sourceVal = document.getElementById('fSource').value;
    const filtered = allRecords.filter((r) => {
      if (petaniVal && r.kodePetani !== petaniVal) return false;
      if (sourceVal) {
        const p = petaniByKode[r.kodePetani];
        if (!p || p.source !== sourceVal) return false;
      }
      return true;
    });
    currentRows = filtered;
    renderTable(filtered);
    renderMap(filtered);
  }

  document.getElementById('fPetani').addEventListener('change', applyFilters);
  document.getElementById('fSource').addEventListener('change', applyFilters);

  document.getElementById('btnExportExcel').addEventListener('click', () => {
    if (typeof XLSX === 'undefined') {
      toast('Library Excel gagal dimuat (cek koneksi internet), coba muat ulang halaman.', 'error');
      return;
    }
    if (!currentRows.length) { toast('Tidak ada data untuk diekspor.', 'error'); return; }
    try {
      // Column order/names match T_GPS in SQL Server exactly, so this
      // file can be imported directly (Import Flat File / bcp / SSMS).
      const data = currentRows.map((r) => ({
        transID: r.transId ?? '',
        SupplierID: r.kodePetani,
        Lat: r.lat,
        Long: r.lng,
        Alt: r.alt === null || r.alt === undefined ? '' : r.alt,
        Dates: r.tanggal,
        CropYear: r.cropYear || '',
        Source: r.source || '',
        dtRecord: r.dtRecord || '',
        dtModified: r.dtModified || '',
        UserModified: r.userModified || 'sync',
        Username: r.username || 'sync',
        rowguid: r.rowguid || '',
        Remark: r.remark || '-',
        status: r.type,
        userlogin: r.userLogin || '',
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = [
        { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 20 },
        { wch: 10 }, { wch: 10 }, { wch: 20 }, { wch: 20 }, { wch: 12 }, { wch: 10 },
        { wch: 36 }, { wch: 14 }, { wch: 10 }, { wch: 12 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Titik Lokasi');
      XLSX.writeFile(wb, `laporan-titik-lokasi-${todayISO()}.xlsx`);
      toast('Excel diunduh.', 'success');
    } catch (err) {
      toast('Gagal membuat file Excel: ' + err.message, 'error');
    }
  });

  document.getElementById('btnExportMapJpeg').addEventListener('click', async () => {
    if (typeof html2canvas === 'undefined') {
      toast('Library gambar peta gagal dimuat (cek koneksi internet), coba muat ulang halaman.', 'error');
      return;
    }
    if (!currentRows.length) { toast('Tidak ada titik pada peta untuk diekspor.', 'error'); return; }
    const btn = document.getElementById('btnExportMapJpeg');
    btn.disabled = true;
    try {
      const mapEl = document.getElementById('reportMap');
      const canvas = await html2canvas(mapEl, { useCORS: true, allowTaint: false, logging: false });
      await new Promise((resolve) => {
        canvas.toBlob((blob) => {
          if (!blob) { toast('Gagal membuat gambar peta.', 'error'); resolve(); return; }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `peta-titik-lokasi-${todayISO()}.jpg`;
          a.click();
          URL.revokeObjectURL(url);
          toast('Gambar peta (JPEG) diunduh.', 'success');
          resolve();
        }, 'image/jpeg', 0.92);
      });
    } catch (err) {
      toast('Gagal mengekspor peta: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  applyFilters();
}

// ---------------------------------------------------------------
// PAGE: Master Petani
// ---------------------------------------------------------------
async function renderPetaniPage(main) {
  const rows = await DB.getAll('petani');
  const settings = await getAppSettings();
  const defaultSource = State.editingPetani ? '' : settings.source;
  main.innerHTML = `
    <p class="page-eyebrow">Menu 02</p>
    <div class="page-head"><h2>Master Petani</h2></div>

    <div class="panel">
      <h3 id="petaniFormTitle">Tambah Petani</h3>
      <form id="petaniForm">
        <div class="grid-2">
          <div class="field"><label>Kode Petani</label><input type="text" id="pKode" required /></div>
          <div class="field"><label>Nama Petani</label><input type="text" id="pNama" required /></div>
        </div>
        <div class="grid-2">
          <div class="field">
            <label>Source</label>
            <input type="text" id="pSource" value="${esc(defaultSource)}" />
            ${settings.source ? `<div class="hint-text">Default mengikuti Pengaturan: ${esc(settings.source)}</div>` : ''}
          </div>
          <div class="field"><label>Petani Conversion</label><input type="text" id="pConversion" /></div>
        </div>
        <div class="field"><label>Kode FT</label><input type="text" id="pKodeFT" /></div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Simpan</button>
          <button type="button" class="btn btn-ghost hidden" id="pCancelEdit">Batal Edit</button>
        </div>
      </form>
    </div>

    <div class="panel">
      <h3>Daftar Petani (${rows.length})</h3>
      <div class="table-wrap">
        ${rows.length === 0 ? '<div class="empty-state">Belum ada data petani.</div>' : `
        <table>
          <thead><tr><th>Kode</th><th>Nama</th><th>Source</th><th>Conversion</th><th>Kode FT</th><th></th></tr></thead>
          <tbody>
            ${rows.map(p => `
              <tr>
                <td>${esc(p.kodePetani)}</td><td>${esc(p.namaPetani)}</td>
                <td>${esc(p.source)}</td><td>${esc(p.petaniConversion)}</td><td>${esc(p.kodeFT)}</td>
                <td class="table-actions">
                  <button class="btn btn-ghost btn-sm" data-edit-petani="${esc(p.kodePetani)}">Edit</button>
                  <button class="btn btn-danger btn-sm" data-del-petani="${esc(p.kodePetani)}">Hapus</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>`}
      </div>
    </div>
  `;

  const form = document.getElementById('petaniForm');
  const cancelBtn = document.getElementById('pCancelEdit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const kode = document.getElementById('pKode').value.trim();
    const isNew = !State.editingPetani;
    if (isNew && await DB.get('petani', kode)) {
      toast('Kode petani sudah dipakai.', 'error'); return;
    }
    await DB.put('petani', {
      kodePetani: kode,
      namaPetani: document.getElementById('pNama').value.trim(),
      source: document.getElementById('pSource').value.trim(),
      petaniConversion: document.getElementById('pConversion').value.trim(),
      kodeFT: document.getElementById('pKodeFT').value.trim(),
    });
    toast('Data petani tersimpan.', 'success');
    State.editingPetani = null;
    renderPetaniPage(main);
  });

  cancelBtn.addEventListener('click', () => { State.editingPetani = null; renderPetaniPage(main); });

  main.querySelectorAll('[data-edit-petani]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = await DB.get('petani', btn.dataset.editPetani);
      State.editingPetani = p.kodePetani;
      document.getElementById('petaniFormTitle').textContent = `Edit Petani — ${p.kodePetani}`;
      document.getElementById('pKode').value = p.kodePetani;
      document.getElementById('pKode').disabled = true;
      document.getElementById('pNama').value = p.namaPetani || '';
      document.getElementById('pSource').value = p.source || '';
      document.getElementById('pConversion').value = p.petaniConversion || '';
      document.getElementById('pKodeFT').value = p.kodeFT || '';
      cancelBtn.classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  main.querySelectorAll('[data-del-petani]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Hapus petani ${btn.dataset.delPetani}?`)) return;
      await DB.remove('petani', btn.dataset.delPetani);
      toast('Petani dihapus.');
      renderPetaniPage(main);
    });
  });
}

// ---------------------------------------------------------------
// PAGE: Type
// ---------------------------------------------------------------
async function renderTypePage(main) {
  const rows = await DB.getAll('types');
  main.innerHTML = `
    <p class="page-eyebrow">Menu 03</p>
    <div class="page-head"><h2>Type</h2></div>

    <div class="panel">
      <h3 id="typeFormTitle">Tambah Type</h3>
      <form id="typeForm">
        <div class="field"><label>Nama Type</label><input type="text" id="tName" placeholder="mis. Field / Warehouse" required /></div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Simpan</button>
          <button type="button" class="btn btn-ghost hidden" id="tCancelEdit">Batal Edit</button>
        </div>
      </form>
    </div>

    <div class="panel">
      <h3>Daftar Type (${rows.length})</h3>
      <div class="table-wrap">
        ${rows.length === 0 ? '<div class="empty-state">Belum ada type.</div>' : `
        <table>
          <thead><tr><th>Nama</th><th></th></tr></thead>
          <tbody>
            ${rows.map(t => `
              <tr>
                <td><span class="badge ${t.name.toLowerCase() === 'field' ? 'field' : 'warehouse'}">${esc(t.name)}</span></td>
                <td class="table-actions">
                  <button class="btn btn-ghost btn-sm" data-edit-type="${t.id}">Edit</button>
                  <button class="btn btn-danger btn-sm" data-del-type="${t.id}">Hapus</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>`}
      </div>
    </div>
  `;

  const form = document.getElementById('typeForm');
  const cancelBtn = document.getElementById('tCancelEdit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('tName').value.trim();
    const payload = { name };
    if (State.editingType) payload.id = State.editingType;
    await DB.put('types', payload);
    toast('Type tersimpan.', 'success');
    State.editingType = null;
    renderTypePage(main);
  });

  cancelBtn.addEventListener('click', () => { State.editingType = null; renderTypePage(main); });

  main.querySelectorAll('[data-edit-type]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const t = await DB.get('types', Number(btn.dataset.editType));
      State.editingType = t.id;
      document.getElementById('typeFormTitle').textContent = `Edit Type — ${t.name}`;
      document.getElementById('tName').value = t.name;
      cancelBtn.classList.remove('hidden');
    });
  });

  main.querySelectorAll('[data-del-type]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus type ini?')) return;
      await DB.remove('types', Number(btn.dataset.delType));
      toast('Type dihapus.');
      renderTypePage(main);
    });
  });
}

// ---------------------------------------------------------------
// PAGE: Master Employee
// ---------------------------------------------------------------
async function renderEmployeePage(main) {
  const rows = await DB.getAll('employees');
  main.innerHTML = `
    <p class="page-eyebrow">Menu 04</p>
    <div class="page-head"><h2>Master Employee</h2></div>

    <div class="panel">
      <h3 id="empFormTitle">Tambah Employee</h3>
      <form id="empForm">
        <div class="grid-2">
          <div class="field"><label>Kode NIK</label><input type="text" id="eKodenik" required /></div>
          <div class="field"><label>Nama</label><input type="text" id="eNama" required /></div>
        </div>
        <div class="grid-2">
          <div class="field"><label>Posisi</label><input type="text" id="ePosisi" /></div>
          <div class="field"><label>Password Login</label><input type="text" id="ePassword" placeholder="untuk login form" required /></div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Simpan</button>
          <button type="button" class="btn btn-ghost hidden" id="eCancelEdit">Batal Edit</button>
        </div>
      </form>
    </div>

    <div class="panel">
      <h3>Daftar Employee (${rows.length})</h3>
      <div class="table-wrap">
        ${rows.length === 0 ? '<div class="empty-state">Belum ada data employee.</div>' : `
        <table>
          <thead><tr><th>Kode NIK</th><th>Nama</th><th>Posisi</th><th></th></tr></thead>
          <tbody>
            ${rows.map(e => `
              <tr>
                <td>${esc(e.kodenik)}</td><td>${esc(e.nama)}</td><td>${esc(e.posisi)}</td>
                <td class="table-actions">
                  <button class="btn btn-ghost btn-sm" data-edit-emp="${esc(e.kodenik)}">Edit</button>
                  <button class="btn btn-danger btn-sm" data-del-emp="${esc(e.kodenik)}">Hapus</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>`}
      </div>
    </div>
  `;

  const form = document.getElementById('empForm');
  const cancelBtn = document.getElementById('eCancelEdit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const kodenik = document.getElementById('eKodenik').value.trim();
    const isNew = !State.editingEmployee;
    if (isNew && await DB.get('employees', kodenik)) {
      toast('Kode NIK sudah dipakai.', 'error'); return;
    }
    await DB.put('employees', {
      kodenik,
      nama: document.getElementById('eNama').value.trim(),
      posisi: document.getElementById('ePosisi').value.trim(),
      password: document.getElementById('ePassword').value,
    });
    toast('Data employee tersimpan.', 'success');
    State.editingEmployee = null;
    renderEmployeePage(main);
  });

  cancelBtn.addEventListener('click', () => { State.editingEmployee = null; renderEmployeePage(main); });

  main.querySelectorAll('[data-edit-emp]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const emp = await DB.get('employees', btn.dataset.editEmp);
      State.editingEmployee = emp.kodenik;
      document.getElementById('empFormTitle').textContent = `Edit Employee — ${emp.kodenik}`;
      document.getElementById('eKodenik').value = emp.kodenik;
      document.getElementById('eKodenik').disabled = true;
      document.getElementById('eNama').value = emp.nama || '';
      document.getElementById('ePosisi').value = emp.posisi || '';
      document.getElementById('ePassword').value = emp.password || '';
      cancelBtn.classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  main.querySelectorAll('[data-del-emp]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.delEmp === State.user.kodenik) {
        toast('Tidak bisa menghapus akun yang sedang login.', 'error'); return;
      }
      if (!confirm(`Hapus employee ${btn.dataset.delEmp}?`)) return;
      await DB.remove('employees', btn.dataset.delEmp);
      toast('Employee dihapus.');
      renderEmployeePage(main);
    });
  });
}

// ---------------------------------------------------------------
// PAGE: Pengaturan (global Source & CropYear)
// ---------------------------------------------------------------
async function renderSettingPage(main) {
  const settings = await getAppSettings();
  main.innerHTML = `
    <p class="page-eyebrow">Menu 05</p>
    <div class="page-head"><h2>Pengaturan</h2></div>

    <div class="panel">
      <h3>Source &amp; Crop Year Aktif</h3>
      <p class="hint-text">
        Nilai di sini menjadi acuan tunggal untuk seluruh aplikasi:
        <strong>Source</strong> akan mengisi otomatis Master Petani baru, dan
        <strong>Crop Year</strong> akan otomatis dipakai pada setiap titik
        lokasi baru yang dicatat — tidak perlu diketik ulang setiap saat.
      </p>
      <form id="settingForm">
        <div class="grid-2">
          <div class="field"><label>Source</label><input type="text" id="sSource" value="${esc(settings.source)}" placeholder="mis. Local, Import, dst." /></div>
          <div class="field"><label>Crop Year</label><input type="text" id="sCropYear" value="${esc(settings.cropYear)}" placeholder="mis. 2026" /></div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Simpan Pengaturan</button>
        </div>
      </form>
    </div>
  `;

  document.getElementById('settingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveAppSettings({
      source: document.getElementById('sSource').value.trim(),
      cropYear: document.getElementById('sCropYear').value.trim(),
    });
    toast('Pengaturan tersimpan.', 'success');
  });
}
async function renderSyncPage(main) {
  const cfg = (window.Sync && await Sync.getConfig()) || {};
  main.innerHTML = `
    <p class="page-eyebrow">Menu 07</p>
    <div class="page-head"><h2>Sinkronisasi Firebase</h2></div>

    <div class="panel">
      <h3>Konfigurasi Firebase Project</h3>

      <div class="field">
        <label for="cfJsonFile">Import dari File JSON</label>
        <input type="file" id="cfJsonFile" accept="application/json,.json" />
        <div class="hint-text">
          Terima file hasil <em>copy</em> dari Firebase Console (objek <code>firebaseConfig</code>),
          baik format JSON murni maupun ditempel apa adanya termasuk <code>const firebaseConfig = {...}</code>.
        </div>
      </div>
      <div class="divider"></div>

      <form id="syncCfgForm">
        <div class="grid-2">
          <div class="field"><label>apiKey</label><input type="text" id="cfApiKey" value="${esc(cfg.apiKey)}" required /></div>
          <div class="field"><label>authDomain</label><input type="text" id="cfAuthDomain" value="${esc(cfg.authDomain)}" required /></div>
        </div>
        <div class="grid-2">
          <div class="field"><label>projectId</label><input type="text" id="cfProjectId" value="${esc(cfg.projectId)}" required /></div>
          <div class="field"><label>storageBucket</label><input type="text" id="cfStorageBucket" value="${esc(cfg.storageBucket)}" /></div>
        </div>
        <div class="grid-2">
          <div class="field"><label>messagingSenderId</label><input type="text" id="cfSenderId" value="${esc(cfg.messagingSenderId)}" /></div>
          <div class="field"><label>appId</label><input type="text" id="cfAppId" value="${esc(cfg.appId)}" required /></div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Simpan Konfigurasi</button>
        </div>
      </form>
    </div>

    <div class="panel">
      <h3>Aksi Sinkronisasi</h3>
      <div class="toolbar">
        <button class="btn btn-primary" id="btnPush">⬆ Push ke Firebase</button>
        <button class="btn btn-ghost" id="btnPull">⬇ Pull dari Firebase</button>
      </div>
      <div class="log-box" id="syncLog">Menunggu aksi…</div>
    </div>
  `;

  document.getElementById('cfJsonFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseFirebaseConfigText(text);
      const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
      const missing = required.filter((k) => !parsed[k]);
      if (missing.length) {
        toast('File tidak lengkap, kurang: ' + missing.join(', '), 'error');
        return;
      }
      document.getElementById('cfApiKey').value = parsed.apiKey || '';
      document.getElementById('cfAuthDomain').value = parsed.authDomain || '';
      document.getElementById('cfProjectId').value = parsed.projectId || '';
      document.getElementById('cfStorageBucket').value = parsed.storageBucket || '';
      document.getElementById('cfSenderId').value = parsed.messagingSenderId || '';
      document.getElementById('cfAppId').value = parsed.appId || '';
      toast('Konfigurasi berhasil dibaca dari file. Periksa lalu klik "Simpan Konfigurasi".', 'success');
    } catch (err) {
      toast('Gagal membaca file: ' + err.message, 'error');
    }
  });

  document.getElementById('syncCfgForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cfgObj = {
      apiKey: document.getElementById('cfApiKey').value.trim(),
      authDomain: document.getElementById('cfAuthDomain').value.trim(),
      projectId: document.getElementById('cfProjectId').value.trim(),
      storageBucket: document.getElementById('cfStorageBucket').value.trim(),
      messagingSenderId: document.getElementById('cfSenderId').value.trim(),
      appId: document.getElementById('cfAppId').value.trim(),
    };
    await Sync.saveConfig(cfgObj);
    toast('Konfigurasi Firebase disimpan.', 'success');
  });

  const logBox = document.getElementById('syncLog');
  const log = (msg) => { logBox.textContent += `\n[${new Date().toLocaleTimeString()}] ${msg}`; logBox.scrollTop = logBox.scrollHeight; };

  document.getElementById('btnPush').addEventListener('click', async () => {
    logBox.textContent = 'Memulai push…';
    try {
      await Sync.pushAll(log);
      const recs = await DB.getAll('records');
      await Promise.all(recs.map(r => DB.put('records', { ...r, syncStatus: 'synced' })));
      toast('Push selesai.', 'success');
    } catch (err) {
      log('ERROR: ' + err.message);
      toast('Push gagal: ' + err.message, 'error');
    }
  });

  document.getElementById('btnPull').addEventListener('click', async () => {
    logBox.textContent = 'Memulai pull…';
    try {
      await Sync.pullAll(log);
      toast('Pull selesai.', 'success');
    } catch (err) {
      log('ERROR: ' + err.message);
      toast('Pull gagal: ' + err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------
// PAGE: Backup / Restore (JSON)
// ---------------------------------------------------------------
async function renderBackupPage(main) {
  main.innerHTML = `
    <p class="page-eyebrow">Menu 08</p>
    <div class="page-head"><h2>Backup &amp; Restore</h2></div>

    <div class="panel">
      <h3>Backup ke File JSON</h3>
      <p class="hint-text">Mengunduh seluruh data (petani, type, employee, titik lokasi) dalam satu file JSON.</p>
      <button class="btn btn-primary" id="btnBackup">⬇ Unduh Backup JSON</button>
    </div>

    <div class="panel">
      <h3>Restore dari File JSON</h3>
      <p class="hint-text">Data pada file akan digabungkan (upsert) ke database lokal berdasarkan kode/kunci masing-masing.</p>
      <input type="file" id="restoreFile" accept="application/json" />
      <div class="form-actions">
        <button class="btn btn-danger" id="btnRestore">Restore Data</button>
      </div>
      <div class="log-box hidden" id="restoreLog"></div>
    </div>
  `;

  document.getElementById('btnBackup').addEventListener('click', async () => {
    const payload = {
      meta: { app: 'IDS Tracker System', exportedAt: new Date().toISOString() },
      petani: await DB.getAll('petani'),
      types: await DB.getAll('types'),
      employees: await DB.getAll('employees'),
      records: await DB.getAll('records'),
      settings: await getAppSettings(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ids-tracker-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Backup JSON diunduh.', 'success');
  });

  document.getElementById('btnRestore').addEventListener('click', async () => {
    const fileInput = document.getElementById('restoreFile');
    const logBox = document.getElementById('restoreLog');
    logBox.classList.remove('hidden');
    logBox.textContent = '';

    if (!fileInput.files.length) { toast('Pilih file JSON terlebih dahulu.', 'error'); return; }
    if (!confirm('Restore akan menimpa data dengan kunci yang sama. Lanjutkan?')) return;

    try {
      const text = await fileInput.files[0].text();
      const data = JSON.parse(text);
      if (data.petani) { await DB.bulkPut('petani', data.petani); logBox.textContent += `Petani: ${data.petani.length} baris\n`; }
      if (data.types) { await DB.bulkPut('types', data.types); logBox.textContent += `Type: ${data.types.length} baris\n`; }
      if (data.employees) { await DB.bulkPut('employees', data.employees); logBox.textContent += `Employee: ${data.employees.length} baris\n`; }
      if (data.records) { await DB.bulkPut('records', data.records); logBox.textContent += `Records: ${data.records.length} baris\n`; }
      if (data.settings) { await saveAppSettings(data.settings); logBox.textContent += `Pengaturan Source/Crop Year dipulihkan\n`; }
      logBox.textContent += 'Restore selesai.';
      toast('Restore berhasil.', 'success');
    } catch (err) {
      logBox.textContent += 'ERROR: ' + err.message;
      toast('Restore gagal: file tidak valid.', 'error');
    }
  });
}
