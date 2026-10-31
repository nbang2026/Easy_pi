import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PI_VERSION_URL = 'https://pi.dev/api/latest-version';
export const PI_CHANGELOG_URL = 'https://pi.dev/changelog';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9a-z-]+(?:\.[0-9a-z-]+)*))?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i;
const validVersion = value => typeof value === 'string' && value === value.trim() && value.length <= 64 && VERSION.test(value) &&
  !(value.match(VERSION)[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0'));

export function comparePiVersions(left, right) {
  if (!validVersion(left) || !validVersion(right)) throw Error('Invalid Pi version');
  const a = left.match(VERSION), b = right.match(VERSION);
  for (let i = 1; i <= 3; i++) {
    if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]) ? 1 : -1;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const aa = a[4].split('.'), bb = b[4].split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined || bb[i] === undefined) return aa[i] === bb[i] ? 0 : aa[i] === undefined ? -1 : 1;
    if (aa[i] === bb[i]) continue;
    const an = /^\d+$/.test(aa[i]), bn = /^\d+$/.test(bb[i]);
    if (an && bn) return BigInt(aa[i]) > BigInt(bb[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return aa[i] > bb[i] ? 1 : -1;
  }
  return 0;
}

export function installedPiVersion(entry = process.argv[1]) {
  try {
    let directory = dirname(realpathSync(entry));
    for (let i = 0; i < 10; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        if (['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'].includes(pkg.name) && validVersion(pkg.version)) return pkg.version;
      } catch { /* The CLI entry may live several directories below its package. */ }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch { /* A missing package is reported as unavailable, not as the app version. */ }
  return '';
}

export function createPiUpdateChecker({ currentVersion = installedPiVersion(), fetch: fetcher = globalThis.fetch,
  env = process.env, now = Date.now, timeoutMs = 8000, ttlMs = 4 * 60 * 60 * 1000, changed = () => {} } = {}) {
  let state = { status: validVersion(currentVersion) ? 'unchecked' : 'unavailable',
    currentVersion: validVersion(currentVersion) ? currentVersion : '', latestVersion: '', checkedAt: 0,
    runtimeKind: env.PI_GUI_RUNTIME_KIND === 'bundled' ? 'bundled' : 'external' };
  let pending, controller, disposed = false;
  const snapshot = () => ({ ...state });
  const publish = value => {
    if (disposed) return;
    state = { ...state, ...value };
    try { changed(snapshot()); } catch { /* Update notices must never interrupt Pi. */ }
  };
  const check = ({ force = false } = {}) => {
    if (disposed || !state.currentVersion) return Promise.resolve(snapshot());
    if (pending) return pending;
    if (env.PI_OFFLINE || env.PI_SKIP_VERSION_CHECK) {
      publish({ status: 'disabled' });
      return Promise.resolve(snapshot());
    }
    if (!force && state.checkedAt && now() - state.checkedAt < ttlMs && state.status !== 'error') return Promise.resolve(snapshot());
    publish({ status: 'checking', error: undefined });
    controller = new AbortController();
    const signal = controller.signal;
    let timer;
    const cancelled = new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
      timer = setTimeout(() => controller?.abort(), timeoutMs);
    });
    const request = (async () => {
      let response;
      try {
        // Fixed official metadata endpoint only; never send model keys,
        // project paths, session contents or a user-configured relay URL.
        response = await fetcher(PI_VERSION_URL, { signal, redirect: 'error', credentials: 'omit',
          headers: { accept: 'application/json' } });
        if (!response.ok) throw Error('http');
        if (Number(response.headers.get('content-length')) > 32768) throw Error('invalid');
        if (!response.body) throw Error('invalid');
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 32768 || signal.aborted) throw Error('invalid');
            chunks.push(value);
          }
        } finally { void reader.cancel().catch(() => {}); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let data;
        try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw Error('invalid'); }
        if (!validVersion(data?.version)) throw Error('invalid');
        return data.version;
      } finally { void response?.body?.cancel().catch(() => {}); }
    })();
    pending = Promise.race([request, cancelled]).then(latestVersion => {
      publish({ status: comparePiVersions(latestVersion, currentVersion) > 0 ? 'available' : 'current',
        latestVersion, checkedAt: now(), error: undefined });
      return snapshot();
    }, error => {
      publish({ status: 'error', checkedAt: now(), error: signal.aborted ? 'timeout' : error?.message === 'invalid' || error instanceof SyntaxError ? 'invalid' : 'network' });
      return snapshot();
    }).finally(() => { clearTimeout(timer); pending = undefined; controller = undefined; });
    return pending;
  };
  return { snapshot, check, dispose() { disposed = true; controller?.abort(); } };
}
