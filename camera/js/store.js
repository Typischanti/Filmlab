// Galerie in IndexedDB. Bilddaten werden als ArrayBuffer abgelegt (Blobs in
// IndexedDB waren in Safari lange unzuverlässig).
//
// photos: { id, created, takenAt, settings, w, h, thumb: {type, data} }
// blobs:  key `${id}:src` (unentwickeltes Original) / `${id}:out` (Abzug)

const DB_NAME = 'filmkamera';
const VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(stores, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let result;
        Promise.resolve(fn(t)).then((r) => (result = r), reject);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error ?? new Error('Speichern abgebrochen'));
      }),
  );
}

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function pack(blob) {
  return { type: blob.type, data: await blob.arrayBuffer() };
}

function unpack(v) {
  return v ? new Blob([v.data], { type: v.type }) : null;
}

export function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export async function savePhoto(meta, { src, out, thumb }) {
  const packed = {
    src: src ? await pack(src) : null,
    out: out ? await pack(out) : null,
    thumb: thumb ? await pack(thumb) : null,
  };
  await tx(['photos', 'blobs'], 'readwrite', (t) => {
    const record = { ...meta };
    if (packed.thumb) record.thumb = packed.thumb;
    t.objectStore('photos').put(record);
    if (packed.src) t.objectStore('blobs').put(packed.src, `${meta.id}:src`);
    if (packed.out) t.objectStore('blobs').put(packed.out, `${meta.id}:out`);
  });
}

export async function listPhotos() {
  const all = await tx(['photos'], 'readonly', (t) => reqP(t.objectStore('photos').getAll()));
  return all
    .map((p) => ({ ...p, thumb: unpack(p.thumb) }))
    .sort((a, b) => b.created - a.created);
}

export async function getBlob(id, kind) {
  const v = await tx(['blobs'], 'readonly', (t) => reqP(t.objectStore('blobs').get(`${id}:${kind}`)));
  return unpack(v);
}

// Metadaten mehrerer Fotos ändern (z. B. Filmrolle entwickelt), Bilder bleiben.
export async function updatePhotos(ids, patch) {
  await tx(['photos'], 'readwrite', async (t) => {
    const os = t.objectStore('photos');
    for (const id of ids) {
      const rec = await reqP(os.get(id));
      if (rec) os.put({ ...rec, ...patch });
    }
  });
}

export async function deletePhotos(ids) {
  await tx(['photos', 'blobs'], 'readwrite', (t) => {
    for (const id of ids) {
      t.objectStore('photos').delete(id);
      t.objectStore('blobs').delete(`${id}:src`);
      t.objectStore('blobs').delete(`${id}:out`);
    }
  });
}

// Bitte um dauerhaften Speicher, damit iOS die Galerie nicht aufräumt.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* egal */
  }
}
