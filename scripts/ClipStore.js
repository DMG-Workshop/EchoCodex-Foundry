/**
 * Durable storage for recorded clips.
 *
 * Clips used to live only as Blobs in a JavaScript array, which meant a browser
 * refresh three hours into a session lost the session outright — and Foundry
 * worlds get refreshed mid-game for all sorts of ordinary reasons. Each clip is
 * now written as it closes, so a reload can pick the recording back up.
 *
 * The IndexedDB calls are isolated behind a tiny backend interface so the
 * bookkeeping above them can be tested without a browser.
 */

const DB_NAME = 'echo-codex-notes';
const STORE_NAME = 'clips';
const DB_VERSION = 1;

export class ClipStore {
  constructor(backend) {
    this.backend = backend;
  }

  /** Records a clip against the session that produced it. */
  async put(sessionId, clip) {
    await this.backend.put({
      key: `${sessionId}:${String(clip.index).padStart(4, '0')}`,
      sessionId,
      index: clip.index,
      offsetMs: clip.offsetMs,
      type: clip.blob?.type ?? 'audio/webm',
      size: clip.blob?.size ?? 0,
      blob: clip.blob,
      storedAt: Date.now()
    });
  }

  /** Every clip of one session, in recording order. */
  async listSession(sessionId) {
    const rows = await this.backend.list();
    return rows
      .filter(row => row.sessionId === sessionId)
      .sort((a, b) => a.index - b.index)
      .map(toClip);
  }

  /**
   * Sessions still on disk, newest first — what a reload offers to recover.
   * `metadata` is absent for a session that was cut off before it was written.
   */
  async listSessions() {
    const rows = await this.backend.list();
    const sessions = new Map();

    for (const row of rows) {
      const entry = sessions.get(row.sessionId) ?? {
        sessionId: row.sessionId,
        clipCount: 0,
        bytes: 0,
        storedAt: 0,
        metadata: null
      };
      entry.clipCount += 1;
      entry.bytes += row.size ?? 0;
      entry.storedAt = Math.max(entry.storedAt, row.storedAt ?? 0);
      if (row.metadata) entry.metadata = row.metadata;
      sessions.set(row.sessionId, entry);
    }

    return [...sessions.values()].sort((a, b) => b.storedAt - a.storedAt);
  }

  /** Stamps session metadata onto the first clip, so a recovered session knows its own name. */
  async attachMetadata(sessionId, metadata) {
    const rows = await this.backend.list();
    const first = rows
      .filter(row => row.sessionId === sessionId)
      .sort((a, b) => a.index - b.index)[0];
    if (!first) return false;
    await this.backend.put({ ...first, metadata });
    return true;
  }

  async deleteSession(sessionId) {
    const rows = await this.backend.list();
    const keys = rows.filter(row => row.sessionId === sessionId).map(row => row.key);
    for (const key of keys) await this.backend.delete(key);
    return keys.length;
  }

  /** Drops sessions older than the retention window; 0 keeps everything. */
  async prune({ maxAgeMs = 0, now = Date.now() } = {}) {
    if (!maxAgeMs) return [];
    const sessions = await this.listSessions();
    const stale = sessions.filter(s => now - s.storedAt > maxAgeMs);
    for (const session of stale) await this.deleteSession(session.sessionId);
    return stale.map(s => s.sessionId);
  }
}

function toClip(row) {
  return { blob: row.blob, offsetMs: row.offsetMs, index: row.index };
}

export function newSessionId(now = Date.now()) {
  return `s${now}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ *
 * IndexedDB backend
 * ------------------------------------------------------------------ */

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createIndexedDbBackend(factory = globalThis.indexedDB) {
  if (!factory) return null;

  let dbPromise = null;
  const open = () => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = factory.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  };

  const withStore = async (mode, fn) => {
    const db = await open();
    const tx = db.transaction(STORE_NAME, mode);
    const result = await fn(tx.objectStore(STORE_NAME));
    return result;
  };

  return {
    put: (row) => withStore('readwrite', (store) => promisify(store.put(row))),
    list: () => withStore('readonly', (store) => promisify(store.getAll())),
    delete: (key) => withStore('readwrite', (store) => promisify(store.delete(key)))
  };
}

/** In-memory fallback: a session survives a dialog, just not a reload. */
export function createMemoryBackend() {
  const rows = new Map();
  return {
    put: async (row) => { rows.set(row.key, row); },
    list: async () => [...rows.values()],
    delete: async (key) => { rows.delete(key); }
  };
}
