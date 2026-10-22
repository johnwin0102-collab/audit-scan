/* Audit Scan storage: batches and pages live in the phone's IndexedDB, so nothing is lost
   if the app closes mid-batch. Nothing here leaves the phone. */
"use strict";

const DB = (() => {
  const NAME = "audit-scan";
  const VERSION = 1;
  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const r = indexedDB.open(NAME, VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains("batches")) db.createObjectStore("batches", { keyPath: "id" });
          if (!db.objectStoreNames.contains("pages")) {
            const s = db.createObjectStore("pages", { keyPath: "id" });
            s.createIndex("batchId", "batchId");
          }
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error("Storage is busy in another tab. Close other Audit Scan tabs."));
      });
    }
    return opening;
  }

  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const done = (t) => new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Storage write was cancelled"));
  });

  async function put(store, value) {
    const db = await open();
    const t = db.transaction(store, "readwrite");
    t.objectStore(store).put(value);
    return done(t);
  }
  async function get(store, key) {
    const db = await open();
    return req(db.transaction(store).objectStore(store).get(key));
  }
  async function getAll(store) {
    const db = await open();
    return req(db.transaction(store).objectStore(store).getAll());
  }
  async function del(store, key) {
    const db = await open();
    const t = db.transaction(store, "readwrite");
    t.objectStore(store).delete(key);
    return done(t);
  }
  async function pagesOf(batchId) {
    const db = await open();
    return req(db.transaction("pages").objectStore("pages").index("batchId").getAll(batchId));
  }
  async function deleteBatch(batchId) {
    const db = await open();
    const t = db.transaction(["pages", "batches"], "readwrite");
    const pages = t.objectStore("pages");
    const cursor = pages.index("batchId").openKeyCursor(IDBKeyRange.only(batchId));
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) { pages.delete(c.primaryKey); c.continue(); }
    };
    t.objectStore("batches").delete(batchId);
    return done(t);
  }

  return { open, put, get, getAll, del, pagesOf, deleteBatch };
})();
