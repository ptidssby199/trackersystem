/**
 * sync.js — Firebase Firestore sync for IDS Tracker System
 * Loaded as ES module. Firebase SDK is imported dynamically only when
 * the user saves a config, so the app works fully offline without it.
 *
 * Firestore is accessed using a dedicated Firebase Authentication
 * (email/password) account — separate from the app's own "ID Pegawai"
 * login, which stays local (IndexedDB) and unrelated to Firebase.
 */
const Sync = (() => {
  let firebaseApp = null;
  let firestoreDb = null;
  let firebaseAuth = null;

  async function loadFirebase(cfg) {
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
    const firestore = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const authMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    firebaseApp = initializeApp(cfg);
    firestoreDb = firestore.getFirestore(firebaseApp);
    firebaseAuth = authMod.getAuth(firebaseApp);

    if (cfg.authEmail && cfg.authPassword) {
      try {
        await authMod.signInWithEmailAndPassword(firebaseAuth, cfg.authEmail, cfg.authPassword);
      } catch (err) {
        throw new Error(`Login Firebase Authentication gagal (${cfg.authEmail}): ${err.message}`);
      }
    }
    return firestore;
  }

  async function getConfig() {
    return DB.get('config', 'firebase');
  }

  async function saveConfig(cfg) {
    await DB.put('config', { key: 'firebase', ...cfg });
  }

  async function testConnection(cfg) {
    await loadFirebase(cfg);
    return true;
  }

  async function pushAll(log) {
    const cfgRow = await getConfig();
    if (!cfgRow) throw new Error('Konfigurasi Firebase belum diatur.');
    const firestore = await loadFirebase(cfgRow);
    const { collection, doc, setDoc } = firestore;

    const stores = [
      { name: 'petani', keyField: 'kodePetani' },
      { name: 'employees', keyField: 'kodenik' },
      { name: 'types', keyField: 'id' },
      { name: 'records', keyField: 'id' },
      { name: 'areas', keyField: 'id' },
    ];

    for (const s of stores) {
      const rows = await DB.getAll(s.name);
      log(`Mengirim ${rows.length} data dari "${s.name}"...`);
      for (const row of rows) {
        const id = String(row[s.keyField]);
        await setDoc(doc(collection(firestoreDb, s.name), id), row);
      }
    }
    log('Push selesai. Semua data lokal telah dikirim ke Firebase.');
  }

  async function pullAll(log) {
    const cfgRow = await getConfig();
    if (!cfgRow) throw new Error('Konfigurasi Firebase belum diatur.');
    const firestore = await loadFirebase(cfgRow);
    const { collection, getDocs } = firestore;

    const stores = ['petani', 'employees', 'types', 'records', 'areas'];
    for (const name of stores) {
      const snap = await getDocs(collection(firestoreDb, name));
      const rows = [];
      snap.forEach((d) => rows.push(d.data()));
      log(`Menerima ${rows.length} data untuk "${name}"...`);
      await DB.bulkPut(name, rows);
    }
    log('Pull selesai. Data dari Firebase telah disimpan ke perangkat ini.');
  }

  return { getConfig, saveConfig, testConnection, pushAll, pullAll };
})();

window.Sync = Sync;
window.SyncReady = true;
