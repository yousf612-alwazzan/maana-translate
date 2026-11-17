// IndexedDB translation cache. Every function fails soft so translation works without it.

const DB_NAME = 'maana-cache';
const STORE = 't';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'k' });
        store.createIndex('ts', 'ts');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
    dbPromise.catch(() => { dbPromise = null; }); // allow retry later
  }
  return dbPromise;
}

// Wrap an IDBRequest/transaction completion in a promise.
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// SHA-1 hex of a string.
export async function hashKey(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Returns Map<key, value> with hits only.
export async function getMany(keys) {
  const out = new Map();
  try {
    if (!keys || !keys.length) return out;
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    await Promise.all(keys.map(async (k) => {
      try {
        const rec = await reqResult(store.get(k));
        if (rec) out.set(k, rec.v);
      } catch { /* skip this key */ }
    }));
  } catch { /* cache unavailable */ }
  return out;
}

// entries: Array<[key, value]>
export async function putMany(entries) {
  try {
    if (!entries || !entries.length) return;
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const ts = Date.now();
    for (const [k, v] of entries) store.put({ k, v, ts });
    await txDone(tx);
  } catch { /* ignore */ }
}

export async function clearAll() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await txDone(tx);
  } catch { /* ignore */ }
}

// Delete the oldest entries beyond maxEntries.
export async function prune(maxEntries = 40000) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const total = await reqResult(store.count());
    let excess = total - maxEntries;
    if (excess > 0) {
      await new Promise((resolve, reject) => {
        const cur = store.index('ts').openCursor(); // ascending: oldest first
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c || excess <= 0) return resolve();
          c.delete();
          excess--;
          c.continue();
        };
        cur.onerror = () => reject(cur.error);
      });
    }
    await txDone(tx);
  } catch { /* ignore */ }
}
