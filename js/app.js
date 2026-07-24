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
};

function toast(msg, kind = '') {
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
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

  const savedUser = sessionStorage.getItem('idsTrackerUser');
  if (savedUser) {
    State.user = JSON.parse(savedUser);
    showApp();
  }
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

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      item.classList.add('active');
      State.page = item.dataset.page;
      renderPage();
    });
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
          <thead><tr><th>Tanggal</th><th>Kode Petani</th><th>Nama Petani</th><th>Type</th><th>Koordinat</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${records.slice(0, 25).map(r => `
              <tr>
                <td>${esc(r.tanggal)}</td>
                <td>${esc(r.kodePetani)}</td>
                <td>${esc(r.namaPetani)}</td>
                <td><span class="badge ${r.type.toLowerCase() === 'field' ? 'field' : 'warehouse'}">${esc(r.type)}</span></td>
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
    const kodePetani = document.getElementById('rPetani').value;
    const petani = State.petaniCache.find(p => p.kodePetani === kodePetani);
    const record = {
      tanggal: document.getElementById('rTanggal').value,
      kodePetani,
      namaPetani: petani ? petani.namaPetani : '',
      type: document.getElementById('rType').value,
      lat: State.gps.lat,
      lng: State.gps.lng,
      kodenikPencatat: State.user.kodenik,
      syncStatus: 'pending',
      createdAt: new Date().toISOString(),
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
    setGpsValue(pos.lat, pos.lng);
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
      const { latitude, longitude } = pos.coords;
      setGpsValue(latitude, longitude);
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

function setGpsValue(lat, lng) {
  State.gps = { lat, lng };
  document.getElementById('gpsCoords').textContent = `Lat: ${lat.toFixed(6)}  ·  Lng: ${lng.toFixed(6)}`;
  document.getElementById('btnSaveRecord').disabled = false;
}

// ---------------------------------------------------------------
// PAGE: Master Petani
// ---------------------------------------------------------------
async function renderPetaniPage(main) {
  const rows = await DB.getAll('petani');
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
          <div class="field"><label>Source</label><input type="text" id="pSource" /></div>
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
// PAGE: Sinkronisasi Firebase
// ---------------------------------------------------------------
async function renderSyncPage(main) {
  const cfg = (window.Sync && await Sync.getConfig()) || {};
  main.innerHTML = `
    <p class="page-eyebrow">Menu 05</p>
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
    <p class="page-eyebrow">Menu 06</p>
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
