/* The save files the player opened in this browser, and their unsaved changes.

   A save never leaves the browser (docs/ARCHITECTURE.md "Why save files"): Home deposits take
   Pokémon out of the working copy, withdrawals put them in, and the player downloads the
   working copy to replace their file. This module only keeps bytes and bookkeeping; parsing is
   shared/saves (openSave/exportSave), done by the views.

   Entry: { id, filename, size, original, working, dirty, addedAt, updatedAt, lastExported, meta }
     original      Uint8Array exactly as opened (kept for "revert" and for comparing)
     working       Uint8Array with the changes made so far
     dirty         working has changes that have not been downloaded yet
     lastExported  time of the last download (null if never)
     meta          small JSON-able object views may use (detected game, trainer name, ...)

   Persistence is best effort. Widget iframes get partitioned storage, Brave clears it, Commet
   and Vommet widget windows are incognito, and some sandboxes throw on indexedDB access at all
   (docs/research/matrix-widget.md §5.4). Every IndexedDB call is wrapped; when it fails the
   store keeps working in memory and `persistent` says so, which is why the UI must always
   offer the download. */

const DB_PREFIX = "pmw-saves";
const DB_VERSION = 1;
const STORE = "saves";

function copy(bytes) {
  if (bytes instanceof Uint8Array) return new Uint8Array(bytes);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  throw new TypeError("save bytes must be a Uint8Array or ArrayBuffer");
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function newId() {
  const r = globalThis.crypto && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(8)) : Array.from({ length: 8 }, () => Math.random() * 256);
  return "s" + Array.from(r, (b) => (b & 255).toString(16).padStart(2, "0")).join("");
}

/** Strip path parts and characters file systems refuse; keep the extension. */
export function safeFilename(name, fallback = "save.sav") {
  let s = String(name || "").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
  s = s.replace(/^\.+/, "");
  return s.slice(0, 120) || fallback;
}

/** Trigger a browser download of bytes. Must run inside a click handler (user activation):
    sandboxed iframes only download from a gesture, and Element's sandbox has allow-downloads. */
export function downloadBlob(bytes, filename, type = "application/octet-stream") {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFilename(filename);
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking at once can cancel the download in some browsers; a minute is plenty.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function createSaveStore({ indexedDB: idb, dbName = DB_PREFIX } = {}) {
  const saves = new Map();
  const listeners = new Set();
  let dbPromise = null;
  let persistent = false;

  function getIdb() {
    if (idb !== undefined) return idb;
    try { return globalThis.indexedDB || null; } catch { return null; }
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try {
        const factory = getIdb();
        if (!factory) return resolve(null);
        req = factory.open(dbName, DB_VERSION);
      } catch {
        return resolve(null);
      }
      const timer = setTimeout(() => resolve(null), 3000);   // blocked/hanging open in odd hosts
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(STORE, { keyPath: "id" }); } catch { /* exists */ }
      };
      req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
      req.onerror = () => { clearTimeout(timer); resolve(null); };
      req.onblocked = () => { clearTimeout(timer); resolve(null); };
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await openDb();
    if (!db) return undefined;
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(r && "result" in r ? r.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error("aborted"));
      });
    } catch (e) {
      console.warn("save storage failed:", e && e.message);
      persistent = false;
      return undefined;
    }
  }

  function toRecord(e) {
    return { ...e, original: e.original, working: e.working, meta: { ...e.meta } };
  }

  async function persist(e) {
    const ok = await tx("readwrite", (s) => s.put(toRecord(e)));
    return ok !== undefined;
  }

  function emit() {
    const list = api.list();
    for (const fn of listeners) {
      try { fn(list); } catch (err) { console.error(err); }
    }
  }

  function need(id) {
    const e = saves.get(id);
    if (!e) throw new Error("That save is no longer open.");
    return e;
  }

  let readyPromise = null;

  const api = {
    /** Keep saves per Matrix account (two accounts in one browser, or the dev harness's two
        frames, must not see each other's working copies). Call before ready(). */
    useScope(key) {
      if (dbPromise) throw new Error("savestore: useScope() must come before the first storage access");
      dbName = DB_PREFIX + ":" + String(key);
    },

    /** Load whatever an earlier visit stored (best effort). Safe to call more than once. */
    ready() {
      if (readyPromise) return readyPromise;
      readyPromise = (async () => {
        const rows = await tx("readonly", (s) => s.getAll());
        if (Array.isArray(rows)) {
          persistent = true;
          for (const r of rows) {
            if (!r || !r.id || !(r.original instanceof Uint8Array) || !(r.working instanceof Uint8Array)) continue;
            if (!saves.has(r.id)) saves.set(r.id, { ...r, meta: r.meta || {} });
          }
          if (rows.length) emit();
        }
        return api.list();
      })();
      return readyPromise;
    },

    /** True when the last storage operation reached IndexedDB. */
    get persistent() { return persistent; },

    /** Store a newly opened file. Returns the entry (also when it could not be persisted). */
    async add(bytes, filename, meta = {}) {
      const original = copy(bytes);
      const now = Date.now();
      const e = {
        id: newId(), filename: safeFilename(filename), size: original.length,
        original, working: new Uint8Array(original), dirty: false,
        addedAt: now, updatedAt: now, lastExported: null, meta: { ...meta },
      };
      saves.set(e.id, e);
      emit();
      persistent = await persist(e);
      return e;
    },

    /** All open saves, oldest first. */
    list() {
      return [...saves.values()].sort((a, b) => a.addedAt - b.addedAt);
    },

    get(id) {
      return saves.get(id) || null;
    },

    /** Replace the working copy (after a deposit/withdrawal). Marks the save dirty. */
    async update(id, newBytes, metaPatch) {
      const e = need(id);
      e.working = copy(newBytes);
      e.size = e.working.length;
      e.dirty = true;
      e.updatedAt = Date.now();
      if (metaPatch) Object.assign(e.meta, metaPatch);
      emit();
      await persist(e);
      return e;
    },

    /** Merge small JSON-able facts about the save (no dirty flag change). */
    async setMeta(id, patch) {
      const e = need(id);
      Object.assign(e.meta, patch);
      emit();
      await persist(e);
      return e;
    },

    /** Call after the working copy was downloaded. */
    async markExported(id) {
      const e = need(id);
      e.dirty = false;
      e.lastExported = Date.now();
      emit();
      await persist(e);
      return e;
    },

    /** Throw away changes: working copy back to the bytes as opened. */
    async revert(id) {
      const e = need(id);
      e.working = new Uint8Array(e.original);
      e.size = e.working.length;
      e.dirty = false;
      e.updatedAt = Date.now();
      emit();
      await persist(e);
      return e;
    },

    async remove(id) {
      if (!saves.delete(id)) return false;
      emit();
      await tx("readwrite", (s) => s.delete(id));
      return true;
    },

    /** True when the working copy differs from the file as opened. */
    changedSinceOpen(id) {
      const e = need(id);
      return !sameBytes(e.original, e.working);
    },

    /** fn(list) after every change. Returns an unsubscribe function. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Download the working copy under its original file name and mark it exported.
        Call from a click handler. */
    async download(id, filename) {
      const e = need(id);
      downloadBlob(e.working, filename || e.filename);
      return api.markExported(id);
    },

    downloadBlob,
  };
  return api;
}

/** The app-wide store (app.store). */
export const store = createSaveStore();
