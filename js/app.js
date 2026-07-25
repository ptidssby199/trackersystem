/**
 * app.js — application shell, routing and page logic for IDS Tracker System
 */

// ---------------------------------------------------------------
// State & utilities
// ---------------------------------------------------------------
const State = {
  user: null,
  page: 'dashboard',
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

// Formats a Date as 'YYYY-MM-DD HH.MM.SS' (dot-separated time), the
// datetime format expected by the SQL Server sync target.
function formatSqlDateTime(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

// Generates a unique 10-digit numeric transaction ID (as a string, so
// leading behaviour is stable and it round-trips cleanly to SQL Server).
async function generateTransId() {
  const existing = new Set((await DB.getAll('records')).map((r) => r.transId));
  let id;
  do {
    id = String(Math.floor(1000000000 + Math.random() * 9000000000));
  } while (existing.has(id));
  return id;
}

// Global app settings (Source & CropYear), managed from the Setting menu.
// Once set, every new petani/record automatically follows these values.
const DEFAULT_APP_SETTINGS = { source: '', cropYear: new Date().getFullYear() };
async function getAppSettings() {
  const row = await DB.get('config', 'appSettings').catch(() => null);
  return { ...DEFAULT_APP_SETTINGS, ...(row || {}) };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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
    State.page = 'dashboard';
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
    item.addEventListener('click', () => goToPage(item.dataset.page));
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

function goToPage(page) {
  State.page = page;
  document.querySelectorAll('.bn-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  renderPage();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  document.getElementById('userLabel').textContent = `${State.user.nama} · ${State.user.kodenik}`;
  document.querySelectorAll('.bn-item').forEach((n) => n.classList.toggle('active', n.dataset.page === State.page));
  renderPage();
}

// ---------------------------------------------------------------
// Router
// ---------------------------------------------------------------
async function renderPage() {
  const main = document.getElementById('mainContent');
  switch (State.page) {
    case 'dashboard': return renderDashboardPage(main);
    case 'record': return renderRecordPage(main);
    case 'petani': return renderPetaniPage(main);
    case 'type': return renderTypePage(main);
    case 'employee': return renderEmployeePage(main);
    case 'laporan': return renderReportPage(main);
    case 'settings': return renderSettingsPage(main);
    case 'sync': return renderSyncPage(main);
    case 'backup': return renderBackupPage(main);
    default: main.innerHTML = '<p>Halaman tidak ditemukan.</p>';
  }
}

// ---------------------------------------------------------------
// PAGE: Dashboard (landing page after login)
// ---------------------------------------------------------------
const DASHBOARD_CARDS = [
  { page: 'record', label: 'Catat Lokasi', desc: 'Rekam titik GPS baru', icon: '📍' },
  { page: 'petani', label: 'Master Petani', desc: 'Kelola data petani', icon: '🧑\u200d🌾' },
  { page: 'type', label: 'Type', desc: 'Atur kategori, icon & warna', icon: '🗂️' },
  { page: 'employee', label: 'Master Pegawai', desc: 'Kelola akun pegawai', icon: '🪪' },
  { page: 'laporan', label: 'Laporan', desc: 'Peta & export data', icon: '🗺️' },
  { page: 'settings', label: 'Setting', desc: 'Source & Crop Year global', icon: '⚙️' },
  { page: 'sync', label: 'Sinkronisasi', desc: 'Push/pull Firebase', icon: '🔄' },
  { page: 'backup', label: 'Backup', desc: 'Export/import JSON', icon: '💾' },
];

function dayLabel(d) {
  return ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'][d.getDay()];
}

async function renderDashboardPage(main) {
  const [petaniList, records, typeCache] = await Promise.all([DB.getAll('petani'), DB.getAll('records'), DB.getAll('types')]);
  const settings = await getAppSettings();

  const totalPetani = petaniList.length;
  const totalRecords = records.length;
  const belumSync = records.filter((r) => r.syncStatus !== 'synced').length;
  const fieldCount = records.filter((r) => (r.type || '').toLowerCase() === 'field').length;
  const warehouseCount = totalRecords - fieldCount;

  // Last 7 days activity (for the sparkline bars)
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const count = records.filter((r) => r.tanggal === iso).length;
    days.push({ label: dayLabel(d), iso, count });
  }
  const maxCount = Math.max(1, ...days.map((d) => d.count));

  const recent = [...records]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 6);

  const todayStr = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  main.innerHTML = `
    <p class="page-eyebrow">Ringkasan</p>
    <div class="page-head">
      <h2>Halo, ${esc(State.user.nama.split(' ')[0])} 👋</h2>
      <span class="hint-text">${esc(todayStr)}</span>
    </div>

    <div class="stat-row">
      <div class="stat-card">
        <div class="num">${totalPetani}</div>
        <div class="lbl">Petani Terdaftar</div>
      </div>
      <div class="stat-card">
        <div class="num">${totalRecords}</div>
        <div class="lbl">Total Titik Lokasi</div>
      </div>
      <div class="stat-card ${belumSync > 0 ? 'stat-warn' : ''}">
        <div class="num">${belumSync}</div>
        <div class="lbl">Belum Sinkron</div>
      </div>
      <div class="stat-card">
        <div class="num">${fieldCount} <span class="hint-text" style="font-size:0.9rem;">/ ${warehouseCount}</span></div>
        <div class="lbl">Field / Warehouse</div>
      </div>
    </div>

    <div class="panel">
      <h3>Aktivitas 7 Hari Terakhir</h3>
      <div class="sparkline">
        ${days.map((d) => `
          <div class="spark-col">
            <div class="spark-bar" style="height:${Math.max(6, Math.round((d.count / maxCount) * 64))}px" title="${d.count} titik"></div>
            <div class="spark-count">${d.count}</div>
            <div class="spark-label">${esc(d.label)}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="panel">
      <h3>Akses Cepat</h3>
      <div class="quick-grid">
        ${DASHBOARD_CARDS.map((c) => `
          <button class="quick-card" data-goto="${c.page}">
            <span class="quick-icon">${c.icon}</span>
            <span class="quick-label">${esc(c.label)}</span>
            <span class="quick-desc">${esc(c.desc)}</span>
          </button>
        `).join('')}
      </div>
    </div>

    <div class="panel">
      <h3>Titik Lokasi Terbaru</h3>
      ${recent.length === 0 ? '<div class="empty-state">Belum ada titik lokasi tercatat.</div>' : `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Tanggal</th><th>Kode Petani</th><th>Nama Petani</th><th>Type</th><th>Status</th></tr></thead>
          <tbody>
            ${recent.map((r) => `
              <tr>
                <td>${esc(r.tanggal)}</td>
                <td>${esc(r.kodePetani)}</td>
                <td>${esc(r.namaPetani)}</td>
                <td>${typeBadgeHtml(typeCache, r.type)}</td>
                <td><span class="badge ${r.syncStatus === 'synced' ? 'synced' : 'pending'}">${r.syncStatus === 'synced' ? 'Tersinkron' : 'Belum sinkron'}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`}
    </div>

    ${!settings.source ? `
    <div class="panel panel-notice">
      <h3>⚠️ Setting belum lengkap</h3>
      <p class="hint-text">Source global belum diatur. Buka menu Setting supaya Petani baru & Titik Lokasi baru otomatis terisi dengan benar.</p>
      <button class="btn btn-primary btn-sm" data-goto="settings">Buka Setting</button>
    </div>` : ''}
  `;

  main.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => goToPage(el.dataset.goto));
  });
}

// ---------------------------------------------------------------
// PAGE: Catat Lokasi (core GPS recording feature)
// ---------------------------------------------------------------
async function renderRecordPage(main) {
  State.petaniCache = await DB.getAll('petani');
  State.typeCache = await DB.getAll('types');
  const records = (await DB.getAll('records')).sort((a, b) => b.id - a.id);

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
            <label for="rTanggal">Tanggal Record</label>
            <input type="date" id="rTanggal" value="${todayISO()}" required />
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

        <div class="gps-box">
          <button type="button" class="btn btn-primary" id="btnGetGps">📍 Ambil Lokasi GPS</button>
          <div class="gps-coords" id="gpsCoords">Belum ada koordinat</div>
          <div id="miniMap"></div>
          <div class="hint-text">Geser marker pada peta untuk menyesuaikan titik secara manual bila perlu.</div>
        </div>

        <div class="field">
          <label for="rRemark">Catatan / Remark (opsional)</label>
          <input type="text" id="rRemark" placeholder="Kosongkan jika tidak ada catatan (default: -)" />
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
          <thead><tr><th>Tanggal</th><th>Kode Petani</th><th>Nama Petani</th><th>Type</th><th>Koordinat (Lat, Long, Alt)</th><th>Crop Year</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${records.slice(0, 25).map(r => `
              <tr>
                <td>${esc(r.tanggal)}</td>
                <td>${esc(r.kodePetani)}</td>
                <td>${esc(r.namaPetani)}</td>
                <td>${typeBadgeHtml(State.typeCache, r.type)}</td>
                <td style="font-family:var(--mono);font-size:0.78rem">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}, ${r.altitude != null ? r.altitude.toFixed(1) : '-'}</td>
                <td>${esc(r.cropYear ?? '-')}</td>
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
    const kodePetani = document.getElementById('rPetani').value;
    const petani = State.petaniCache.find(p => p.kodePetani === kodePetani);
    const settings = await getAppSettings();
    const remarkInput = document.getElementById('rRemark').value.trim();
    const record = {
      transId: await generateTransId(),
      tanggal: document.getElementById('rTanggal').value,
      kodePetani,
      namaPetani: petani ? petani.namaPetani : '',
      type: document.getElementById('rType').value,
      lat: State.gps.lat,
      lng: State.gps.lng,
      altitude: State.gps.alt ?? null,
      cropYear: settings.cropYear,
      supplier: (petani && petani.source) || settings.source || '',
      conversion: (petani && petani.petaniConversion) || '-',
      remark: remarkInput || '-',
      userModified: 'sync',
      username: 'sync',
      userLogin: State.user.kodenik,
      kodenikPencatat: State.user.kodenik,
      syncStatus: 'pending',
      createdAt: formatSqlDateTime(new Date()),
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

function recordMarkerIcon() {
  const typeVal = document.getElementById('rType')?.value || '';
  const t = State.typeCache.find((x) => x.name === typeVal);
  const { icon, color } = typeMeta(t);
  return L.divIcon({
    html: `<span class="marker-pin" style="background:${color}">${icon}</span>`,
    className: 'flag-marker',
    iconSize: [30, 30],
    iconAnchor: [15, 28],
    popupAnchor: [0, -26],
  });
}

function initMiniMap() {
  const defaultCenter = [-6.2, 106.816]; // Jakarta fallback
  State.map = L.map('miniMap').setView(defaultCenter, 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(State.map);

  State.marker = L.marker(defaultCenter, { draggable: true, icon: recordMarkerIcon() }).addTo(State.map);
  State.marker.on('dragend', () => {
    const pos = State.marker.getLatLng();
    // Manual drag only repositions lat/lng; keep whatever altitude GPS last reported.
    setGpsValue(pos.lat, pos.lng, State.gps ? State.gps.alt : null);
  });
  document.getElementById('rType').addEventListener('change', () => {
    State.marker.setIcon(recordMarkerIcon());
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
  State.gps = { lat, lng, alt: (alt === null || alt === undefined) ? null : alt };
  const altText = State.gps.alt === null ? '- (tidak tersedia)' : `${State.gps.alt.toFixed(1)} m`;
  document.getElementById('gpsCoords').textContent =
    `Lat: ${lat.toFixed(6)}  ·  Lng: ${lng.toFixed(6)}  ·  Alt: ${altText}`;
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
  const typeCache = await DB.getAll('types');

  main.innerHTML = `
    <p class="page-eyebrow">Menu 05</p>
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
        ${typeCache.map((t) => {
          const { icon, color } = typeMeta(t);
          return `<span><span class="legend-swatch" style="background:${color}"></span>${icon} ${esc(t.name)}</span>`;
        }).join('')}
        <span class="hint-text">Icon besar saat zoom dekat &middot; titik kecil warna sama saat zoom jauh (atur icon/warna di menu Type)</span>
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

  const ZOOM_FLAG_THRESHOLD = 14; // >= this zoom: show the full icon. Below it: show a small colored dot.

  const iconCacheByType = new Map(); // type name -> { flag: L.divIcon, dot: L.divIcon }
  function iconsForType(typeName) {
    if (!iconCacheByType.has(typeName)) {
      const t = typeCache.find((x) => x.name === typeName);
      const { icon, color } = typeMeta(t);
      iconCacheByType.set(typeName, {
        flag: L.divIcon({
          html: `<span class="marker-pin" style="background:${color}">${icon}</span>`,
          className: 'flag-marker',
          iconSize: [30, 30],
          iconAnchor: [15, 28],
          popupAnchor: [0, -26],
        }),
        dot: L.divIcon({
          html: `<span class="marker-dot" style="background:${color}"></span>`,
          className: 'dot-marker',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
          popupAnchor: [0, -8],
        }),
      });
    }
    return iconCacheByType.get(typeName);
  }

  function iconFor(r) {
    const icons = iconsForType(r.type);
    return map.getZoom() >= ZOOM_FLAG_THRESHOLD ? icons.flag : icons.dot;
  }

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
          ${rows.map(r => `
              <tr>
                <td>${esc(r.tanggal)}</td>
                <td>${esc(r.kodePetani)}</td>
                <td>${esc(r.namaPetani)}</td>
                <td>${typeBadgeHtml(typeCache, r.type)}</td>
                <td style="font-family:var(--mono);font-size:0.78rem">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}, ${r.altitude != null ? r.altitude.toFixed(1) : '-'}</td>
                <td>${esc(r.cropYear ?? '-')}</td>
              </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function renderMap(rows, opts = {}) {
    markerLayer.clearLayers();
    if (rows.length === 0) return;
    const latlngs = [];
    rows.forEach((r) => {
      const m = L.marker([r.lat, r.lng], { icon: iconFor(r) }).addTo(markerLayer);
      m.bindPopup(`
        <strong>${esc(r.kodePetani)} — ${esc(r.namaPetani)}</strong><br/>
        Type: ${esc(r.type)}<br/>
        Tanggal: ${esc(r.tanggal)}<br/>
        Crop Year: ${esc(r.cropYear ?? '-')}<br/>
        ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}, ${r.altitude != null ? r.altitude.toFixed(1) : '-'}
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
      const data = currentRows.map((r) => ({
        Tanggal: r.tanggal,
        'Kode Petani': r.kodePetani,
        'Nama Petani': r.namaPetani,
        Type: r.type,
        Latitude: r.lat,
        Longitude: r.lng,
        Altitude: r.altitude != null ? r.altitude : '',
        'Crop Year': r.cropYear ?? '',
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 22 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }];
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
// PAGE: Setting (global Source & CropYear)
// ---------------------------------------------------------------
async function renderSettingsPage(main) {
  const settings = await getAppSettings();
  main.innerHTML = `
    <p class="page-eyebrow">Menu 06</p>
    <div class="page-head"><h2>Pengaturan</h2></div>

    <div class="panel">
      <h3>Source &amp; Crop Year Global</h3>
      <p class="hint-text">
        Nilai di sini berlaku untuk seluruh aplikasi. Setelah disimpan, semua Petani baru dan
        Titik Lokasi baru akan otomatis mengikuti nilai ini — tidak perlu diisi manual lagi.
      </p>
      <form id="settingsForm">
        <div class="grid-2">
          <div class="field">
            <label for="sSource">Source</label>
            <input type="text" id="sSource" value="${esc(settings.source)}" placeholder="mis. Nama proyek / vendor" />
          </div>
          <div class="field">
            <label for="sCropYear">Crop Year</label>
            <input type="number" id="sCropYear" value="${esc(settings.cropYear)}" min="2000" max="2100" required />
          </div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Simpan Pengaturan</button>
        </div>
      </form>
    </div>

    <div class="panel">
      <h3>Pengaturan Aktif Saat Ini</h3>
      <table>
        <tbody>
          <tr><td style="width:160px;"><strong>Source</strong></td><td>${esc(settings.source) || '<span class="hint-text">(belum diatur)</span>'}</td></tr>
          <tr><td><strong>Crop Year</strong></td><td>${esc(settings.cropYear)}</td></tr>
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newSettings = {
      key: 'appSettings',
      source: document.getElementById('sSource').value.trim(),
      cropYear: Number(document.getElementById('sCropYear').value),
    };
    await DB.put('config', newSettings);
    toast('Pengaturan Source & Crop Year tersimpan.', 'success');
    renderSettingsPage(main);
  });
}

// ---------------------------------------------------------------
// PAGE: Master Petani
// ---------------------------------------------------------------
async function renderPetaniPage(main) {
  const rows = await DB.getAll('petani');
  const settings = await getAppSettings();
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
            <input type="text" value="${esc(settings.source) || '(belum diatur)'}" disabled />
            <div class="hint-text">Mengikuti Pengaturan Source di menu Setting.</div>
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
    const currentSettings = await getAppSettings();
    await DB.put('petani', {
      kodePetani: kode,
      namaPetani: document.getElementById('pNama').value.trim(),
      source: currentSettings.source,
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
const TYPE_ICON_CHOICES = ['🚩', '🏭', '📍', '🏬', '🏠', '📦', '🌾', '🌴', '🚜', '⛽', '🏗️', '🔧', '⚠️', '✅', '🛰️', '🧭'];

function typeMeta(t) {
  return {
    icon: (t && t.icon) || '📍',
    color: (t && t.color) || '#c96a2e',
  };
}

function typeBadgeHtml(typeCache, typeName) {
  const t = typeCache.find((x) => x.name === typeName);
  const { icon, color } = typeMeta(t);
  return `<span class="badge" style="background:${color}20;color:${color};border:1px solid ${color}55;">${icon} ${esc(typeName)}</span>`;
}

async function renderTypePage(main) {
  const rows = await DB.getAll('types');
  main.innerHTML = `
    <p class="page-eyebrow">Menu 03</p>
    <div class="page-head"><h2>Type</h2></div>

    <div class="panel">
      <h3 id="typeFormTitle">Tambah Type</h3>
      <form id="typeForm">
        <div class="field"><label>Nama Type</label><input type="text" id="tName" placeholder="mis. Field / Warehouse" required /></div>
        <div class="grid-2">
          <div class="field">
            <label>Icon</label>
            <div class="icon-picker" id="iconPicker">
              ${TYPE_ICON_CHOICES.map((ic) => `<button type="button" class="icon-choice" data-icon="${ic}">${ic}</button>`).join('')}
            </div>
            <input type="text" id="tIconCustom" placeholder="Atau ketik/paste emoji lain di sini" style="margin-top:8px;" />
          </div>
          <div class="field">
            <label>Warna Penanda</label>
            <input type="color" id="tColor" value="#c96a2e" />
            <div class="hint-text">Warna ini dipakai di peta — baik saat zoom dekat (di belakang icon) maupun zoom jauh (titik kecil).</div>
          </div>
        </div>
        <div class="field">
          <label>Preview</label>
          <div id="tPreview"></div>
        </div>
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
                <td>${typeBadgeHtml(rows, t.name)}</td>
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
  const iconCustomInput = document.getElementById('tIconCustom');
  const colorInput = document.getElementById('tColor');
  let selectedIcon = TYPE_ICON_CHOICES[0];

  function updatePreview() {
    const name = document.getElementById('tName').value.trim() || 'Nama Type';
    const color = colorInput.value;
    document.getElementById('tPreview').innerHTML =
      `<span class="badge" style="background:${color}20;color:${color};border:1px solid ${color}55;">${selectedIcon} ${esc(name)}</span>`;
  }

  function setSelectedIcon(icon) {
    selectedIcon = icon;
    iconCustomInput.value = '';
    main.querySelectorAll('.icon-choice').forEach((b) => b.classList.toggle('active', b.dataset.icon === icon));
    updatePreview();
  }

  main.querySelectorAll('.icon-choice').forEach((btn) => {
    btn.addEventListener('click', () => setSelectedIcon(btn.dataset.icon));
  });
  iconCustomInput.addEventListener('input', () => {
    if (iconCustomInput.value.trim()) {
      selectedIcon = iconCustomInput.value.trim();
      main.querySelectorAll('.icon-choice').forEach((b) => b.classList.remove('active'));
      updatePreview();
    }
  });
  colorInput.addEventListener('input', updatePreview);
  document.getElementById('tName').addEventListener('input', updatePreview);
  setSelectedIcon(selectedIcon);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('tName').value.trim();
    const payload = { name, icon: selectedIcon, color: colorInput.value };
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
      colorInput.value = t.color || '#c96a2e';
      setSelectedIcon(t.icon || TYPE_ICON_CHOICES[0]);
      cancelBtn.classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
// PAGE: Sinkronisasi Firebase
// ---------------------------------------------------------------
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
        <div class="divider"></div>
        <p class="hint-text">
          Firestore project ini menggunakan <strong>Firebase Authentication (email/password)</strong>.
          Isi akun sync khusus (bukan akun ID Pegawai) yang sudah dibuat di tab Authentication
          Firebase Console — akun ini dipakai app untuk login ke Firebase sebelum push/pull data.
        </p>
        <div class="grid-2">
          <div class="field"><label>Email Firebase Auth</label><input type="email" id="cfAuthEmail" value="${esc(cfg.authEmail)}" placeholder="mis. sync@namaproyek.com" /></div>
          <div class="field"><label>Password Firebase Auth</label><input type="password" id="cfAuthPassword" value="${esc(cfg.authPassword)}" /></div>
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
      authEmail: document.getElementById('cfAuthEmail').value.trim(),
      authPassword: document.getElementById('cfAuthPassword').value,
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
      logBox.textContent += 'Restore selesai.';
      toast('Restore berhasil.', 'success');
    } catch (err) {
      logBox.textContent += 'ERROR: ' + err.message;
      toast('Restore gagal: file tidak valid.', 'error');
    }
  });
}
