// IndexedDB: assets (música, imágenes, clip de prueba) y videos (galería).
const DB_NAME = 'booth360';
const DB_VER = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('assets')) {
        const s = db.createObjectStore('assets', { keyPath: 'id' });
        s.createIndex('kind', 'kind');
      }
      if (!db.objectStoreNames.contains('videos')) {
        const s = db.createObjectStore('videos', { keyPath: 'id' });
        s.createIndex('created', 'created');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch (e) { /* */ } dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function tx(store, mode, fn, retry = true) {
  return open().then(db => new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(store, mode); } catch (e) {
      // La conexión quedó cerrada (iOS la corta en segundo plano): se reabre una vez y se reintenta.
      dbPromise = null;
      if (retry && e && e.name === 'InvalidStateError') return resolve(tx(store, mode, fn, false));
      return reject(e);
    }
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r && r.result !== undefined ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); },
  put(store, obj) { return tx(store, 'readwrite', s => s.put(obj)); },
  get(store, id) { return tx(store, 'readonly', s => s.get(id)); },
  del(store, id) { return tx(store, 'readwrite', s => s.delete(id)); },
  all(store) { return tx(store, 'readonly', s => s.getAll()); },
  async byKind(kind) { return (await this.all('assets')).filter(a => a.kind === kind); },
  async usage() {
    if (navigator.storage && navigator.storage.estimate) {
      try { return await navigator.storage.estimate(); } catch (e) { /* ignore */ }
    }
    return null;
  },
  async persist() {
    if (navigator.storage && navigator.storage.persist) {
      try { return await navigator.storage.persist(); } catch (e) { return false; }
    }
    return false;
  }
};
