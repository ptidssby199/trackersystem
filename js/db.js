/**
 * db.js — IndexedDB layer for IDS Tracker System
 * Stores: employees, petani, types, records, config
 */
const DB_NAME = 'idsTrackerDB';
const DB_VERSION = 1;

const DB = (() => {
  let db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const _db = e.target.result;

        if (!_db.objectStoreNames.contains('employees')) {
          _db.createObjectStore('employees', { keyPath: 'kodenik' });
        }
        if (!_db.objectStoreNames.contains('petani')) {
          _db.createObjectStore('petani', { keyPath: 'kodePetani' });
        }
        if (!_db.objectStoreNames.contains('types')) {
          const t = _db.createObjectStore('types', { keyPath: 'id', autoIncrement: true });
          t.createIndex('name', 'name', { unique: true });
        }
        if (!_db.objectStoreNames.contains('records')) {
          const r = _db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
          r.createIndex('kodePetani', 'kodePetani', { unique: false });
          r.createIndex('tanggal', 'tanggal', { unique: false });
          r.createIndex('syncStatus', 'syncStatus', { unique: false });
        }
        if (!_db.objectStoreNames.contains('config')) {
          _db.createObjectStore('config', { keyPath: 'key' });
        }
      };

      req.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function tx(storeName, mode = 'readonly') {
    return open().then((_db) => _db.transaction(storeName, mode).objectStore(storeName));
  }

  async function getAll(storeName) {
    const store = await tx(storeName);
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function get(storeName, key) {
    const store = await tx(storeName);
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function put(storeName, value) {
    const store = await tx(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function remove(storeName, key) {
    const store = await tx(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function clear(storeName) {
    const store = await tx(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function bulkPut(storeName, values) {
    const store = await tx(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      let count = 0;
      if (values.length === 0) return resolve(true);
      values.forEach((v) => {
        const req = store.put(v);
        req.onsuccess = () => {
          count++;
          if (count === values.length) resolve(true);
        };
        req.onerror = (e) => reject(e.target.error);
      });
    });
  }

  async function seedIfEmpty() {
    const employees = await getAll('employees');
    if (employees.length === 0) {
      await put('employees', {
        kodenik: 'admin',
        nama: 'Administrator',
        posisi: 'Admin Sistem',
        password: 'admin123',
      });
    }
    const types = await getAll('types');
    if (types.length === 0) {
      await put('types', { id: 1, name: 'Field' });
      await put('types', { id: 2, name: 'Warehouse' });
    }
  }

  return { open, getAll, get, put, remove, clear, bulkPut, seedIfEmpty };
})();
