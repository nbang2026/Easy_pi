export const SOUND_EVENTS = ["click", "toggle", "open", "close", "send", "typing", "scroll"] as const;
export type SoundEvent = typeof SOUND_EVENTS[number];
export type SoundClip = { filename: string; bytes: ArrayBuffer };
export type SoundPack = {
  id: string;
  name: string;
  sounds: Partial<Record<SoundEvent, SoundClip>>;
};
export const MAX_SOUND_FILE = 2 * 1024 * 1024;
export const MAX_SOUND_TOTAL = 8 * 1024 * 1024;
export const MAX_SOUND_ARCHIVE = 12 * 1024 * 1024;
export const MAX_SOUND_PACKS = 8;

export class SoundError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export function isAudioFilename(name: string): boolean {
  return /\.(wav|mp3|m4a|ogg)$/i.test(name);
}

function safePath(path: string): boolean {
  return !!path && path.length <= 240 && !/^[\\/]|[\\:\0\r\n]/.test(path)
    && !path.split("/").some((part) => part === ".." || part === ".");
}

function clip(filename: string, bytes: Uint8Array): SoundClip {
  if (!isAudioFilename(filename)) throw new SoundError("unsupportedAudio");
  if (!bytes.length || bytes.length > MAX_SOUND_FILE) throw new SoundError("tooLarge");
  return { filename, bytes: bytes.slice().buffer as ArrayBuffer };
}

export function packFromEntries(entries: Record<string, Uint8Array>, fallbackName: string): SoundPack {
  const paths = Object.keys(entries);
  if (paths.some((path) => !safePath(path))) throw new SoundError("invalidPack");
  if (paths.length > 48 || paths.reduce((size, path) => size + entries[path].length, 0) > MAX_SOUND_TOTAL) {
    throw new SoundError("tooLarge");
  }
  const manifests = paths.filter((path) => /(^|\/)soundpack\.json$/i.test(path));
  if (manifests.length > 1) throw new SoundError("invalidPack");
  let name = fallbackName.replace(/\.[^.]+$/, "").trim().slice(0, 80) || "Sound pack";
  const sounds: SoundPack["sounds"] = {};
  if (manifests.length) {
    const manifestPath = manifests[0];
    if (entries[manifestPath].length > 16384) throw new SoundError("tooLarge");
    let manifest;
    try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entries[manifestPath])); }
    catch { throw new SoundError("invalidPack"); }
    if (!manifest || manifest.version !== 1 || typeof manifest.name !== "string"
      || !manifest.name.trim() || manifest.name.length > 80 || /[\0\r\n]/.test(manifest.name)
      || !manifest.sounds || typeof manifest.sounds !== "object" || Array.isArray(manifest.sounds)) {
      throw new SoundError("invalidPack");
    }
    name = manifest.name.trim();
    const base = manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1);
    for (const [key, path] of Object.entries(manifest.sounds)) {
      if (!SOUND_EVENTS.includes(key as SoundEvent) || typeof path !== "string" || !safePath(path)
        || !Object.prototype.hasOwnProperty.call(entries, base + path)) throw new SoundError("invalidPack");
      sounds[key as SoundEvent] = clip(base + path, entries[base + path]);
    }
  } else {
    for (const path of paths) {
      const key = path.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase() as SoundEvent;
      if (!SOUND_EVENTS.includes(key) || !isAudioFilename(path)) continue;
      if (sounds[key]) throw new SoundError("invalidPack");
      sounds[key] = clip(path, entries[path]);
    }
  }
  if (!sounds.click) throw new SoundError("missingClick");
  return { id: `custom-${crypto.randomUUID()}`, name, sounds };
}

export async function readSoundPack(file: File): Promise<SoundPack> {
  if (!file.size || file.size > MAX_SOUND_ARCHIVE) throw new SoundError("tooLarge");
  if (isAudioFilename(file.name)) {
    if (file.size > MAX_SOUND_FILE) throw new SoundError("tooLarge");
    return {
      id: `custom-${crypto.randomUUID()}`,
      name: file.name.slice(0, 80),
      sounds: { click: clip(file.name, new Uint8Array(await file.arrayBuffer())) },
    };
  }
  if (!/\.zip$/i.test(file.name)) throw new SoundError("unsupportedAudio");
  const { unzip } = await import("fflate");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    let count = 0;
    let total = 0;
    let failure = "";
    const seen = new Set<string>();
    unzip(bytes, {
      filter(entry) {
        if (++count > 48) { failure = "tooLarge"; return false; }
        if (!safePath(entry.name) || seen.has(entry.name)) { failure = "invalidPack"; return false; }
        seen.add(entry.name);
        if (entry.name.startsWith("__MACOSX/") || entry.name.endsWith("/")) return false;
        const manifest = /(^|\/)soundpack\.json$/i.test(entry.name);
        if (!manifest && !isAudioFilename(entry.name)) return false;
        if (entry.originalSize > (manifest ? 16384 : MAX_SOUND_FILE) || entry.size > MAX_SOUND_FILE
          || (total += entry.originalSize) > MAX_SOUND_TOTAL) { failure = "tooLarge"; return false; }
        return true;
      },
    }, (error, result) => {
      if (error || failure) reject(new SoundError(failure || "invalidPack"));
      else resolve(result);
    });
  });
  return packFromEntries(entries, file.name);
}

export function isStoredSoundPack(value: unknown): value is SoundPack {
  if (!value || typeof value !== "object") return false;
  const pack = value as SoundPack;
  if (typeof pack.id !== "string" || !/^custom-[a-z0-9-]{10,64}$/i.test(pack.id)
    || typeof pack.name !== "string" || !pack.name.trim() || pack.name.length > 80
    || !pack.sounds || typeof pack.sounds !== "object" || !pack.sounds.click) return false;
  let total = 0;
  return Object.entries(pack.sounds).every(([key, value]) =>
    SOUND_EVENTS.includes(key as SoundEvent) && value && typeof value.filename === "string"
    && isAudioFilename(value.filename) && value.bytes instanceof ArrayBuffer
    && value.bytes.byteLength > 0 && value.bytes.byteLength <= MAX_SOUND_FILE
    && (total += value.bytes.byteLength) <= MAX_SOUND_TOTAL);
}

export function createSoundPackStore(factory: IDBFactory | undefined = globalThis.indexedDB) {
  const transaction = <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      if (!factory) { reject(new SoundError("storageFailed")); return; }
      const opening = factory.open("pi-ui-sounds", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("packs", { keyPath: "id" });
      opening.onerror = () => reject(new SoundError("storageFailed"));
      opening.onblocked = () => reject(new SoundError("storageFailed"));
      opening.onsuccess = () => {
        const db = opening.result;
        try {
          const tx = db.transaction("packs", mode);
          const request = operation(tx.objectStore("packs"));
          tx.oncomplete = () => { db.close(); resolve(request.result); };
          tx.onabort = tx.onerror = () => { db.close(); reject(new SoundError("storageFailed")); };
        } catch { db.close(); reject(new SoundError("storageFailed")); }
      };
    });
  return {
    async list() { return (await transaction("readonly", (store) => store.getAll())).filter(isStoredSoundPack); },
    async save(pack: SoundPack) {
      if (!isStoredSoundPack(pack)) throw new SoundError("invalidPack");
      await transaction("readwrite", (store) => store.put(pack));
    },
    async remove(id: string) { await transaction("readwrite", (store) => store.delete(id)); },
  };
}
