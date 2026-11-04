// Browser storage (IndexedDB). Everything the user works on lives here until they download it.
//
// Browsers can drop writes when storage is full, sometimes without an error, so every write is
// read back and compared. A failed check raises StorageFullError, which the app reports.
//
// Stores:
//   clips     {id, name, mode, lang, segInput, segMode, text, vs, done, updatedAt}
//   audio     {id, blob, name, expires}           only while "Keep audio" is on
//   analysis  {id, data, expires}                 spectrogram + posteriors, same switch

const DB_NAME = "bfa-web";
const DB_VERSION = 1;
let dbPromise = null;

export class StorageFullError extends Error {}

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ["clips", "audio", "analysis"]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("transaction aborted"));
    const req = fn(t.objectStore(store));
    if (req) req.onsuccess = () => { result = req.result; };
  }));
}

export const get = (store, id) => tx(store, "readonly", (s) => s.get(id));
export const getAll = (store) => tx(store, "readonly", (s) => s.getAll());
export const del = (store, id) => tx(store, "readwrite", (s) => s.delete(id));

/** Write, then read back and check it landed. `check(saved)` decides what "landed" means. */
export async function putVerified(store, record, check) {
  try {
    await tx(store, "readwrite", (s) => s.put(record));
  } catch (e) {
    if (e && (e.name === "QuotaExceededError" || /quota/i.test(String(e)))) {
      throw new StorageFullError(String(e.message || e));
    }
    throw e;
  }
  const saved = await get(store, record.id);
  if (!saved || !check(saved)) {
    throw new StorageFullError(`the ${store} write for "${record.id}" did not persist`);
  }
}

export function saveClip(rec) {
  rec.updatedAt = Date.now() + Math.random();   // unique stamp, compared on read-back
  const stamp = rec.updatedAt;
  return putVerified("clips", rec, (s) => s.updatedAt === stamp);
}

export function saveAudio(id, blob, name, days) {
  const rec = { id, blob, name, expires: Date.now() + days * 86400e3 };
  return putVerified("audio", rec, (s) => s.blob && s.blob.size === blob.size);
}

export function saveAnalysis(id, data, days) {
  const rec = { id, data, expires: Date.now() + days * 86400e3, stamp: Math.random() };
  return putVerified("analysis", rec, (s) => s.stamp === rec.stamp);
}

/** Drop expired audio and analysis. Returns how many records were removed. */
export async function purgeExpired() {
  let n = 0;
  const now = Date.now();
  for (const store of ["audio", "analysis"]) {
    for (const r of await getAll(store)) {
      if (r.expires && r.expires < now) { await del(store, r.id); n++; }
    }
  }
  return n;
}

export async function clearStore(store) {
  await tx(store, "readwrite", (s) => s.clear());
}

export async function usage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (_) { /* not supported */ }
  return false;
}
