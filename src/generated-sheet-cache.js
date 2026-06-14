const DB_NAME = "pokemon-market-generated-sheets";
const DB_VERSION = 1;
const STORE_NAME = "sheets";
const MAX_CACHE_ENTRIES = 200;
const MAX_CACHE_BYTES = 150 * 1024 * 1024;

let dbPromise = null;

export async function loadGeneratedSheetBlob(cacheKey) {
  if (!cacheKey) return null;

  try {
    const db = await openGeneratedSheetDb();
    const record = await getRecord(db, cacheKey);
    if (!record?.blob) return null;

    await putRecord(db, {
      ...record,
      accessedAt: Date.now(),
    });
    return record.blob;
  } catch (error) {
    console.warn("Generated sheet cache read failed.", error);
    return null;
  }
}

export async function saveGeneratedSheetBlob(cacheKey, blob, metadata = {}) {
  if (!cacheKey || !blob) return false;

  try {
    const db = await openGeneratedSheetDb();
    await putRecord(db, {
      key: cacheKey,
      blob,
      type: blob.type || metadata.type || "image/webp",
      byteSize: Number(blob.size || metadata.byteSize || 0),
      width: Number(metadata.width || 0),
      height: Number(metadata.height || 0),
      revision: Number(metadata.revision || 0),
      createdAt: Date.now(),
      accessedAt: Date.now(),
    });
    pruneGeneratedSheetCache(db);
    return true;
  } catch (error) {
    console.warn("Generated sheet cache write failed.", error);
    return false;
  }
}

function openGeneratedSheetDb() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB is unavailable."));
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("accessedAt", "accessedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed."));
  });

  return dbPromise;
}

function getRecord(db, key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("IndexedDB get failed."));
  });
}

function putRecord(db, record) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(record);

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error || new Error("IndexedDB put failed."));
  });
}

async function pruneGeneratedSheetCache(db) {
  try {
    const records = await getAllRecords(db);
    if (records.length <= MAX_CACHE_ENTRIES && getTotalBytes(records) <= MAX_CACHE_BYTES) return;

    records.sort((a, b) => Number(a.accessedAt || 0) - Number(b.accessedAt || 0));
    let totalBytes = getTotalBytes(records);
    let recordCount = records.length;
    const keysToDelete = [];

    for (const record of records) {
      if (recordCount <= MAX_CACHE_ENTRIES && totalBytes <= MAX_CACHE_BYTES) break;
      keysToDelete.push(record.key);
      totalBytes -= Number(record.byteSize || record.blob?.size || 0);
      recordCount -= 1;
    }

    if (keysToDelete.length > 0) await deleteRecords(db, keysToDelete);
  } catch (error) {
    console.warn("Generated sheet cache prune failed.", error);
  }
}

function getAllRecords(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error || new Error("IndexedDB getAll failed."));
  });
}

function deleteRecords(db, keys) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    for (const key of keys) {
      store.delete(key);
    }

    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB delete failed."));
  });
}

function getTotalBytes(records) {
  return records.reduce((sum, record) => sum + Number(record.byteSize || record.blob?.size || 0), 0);
}
