import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiUpdateChecker, comparePiVersions, installedPiVersion, PI_VERSION_URL } from '../src-tauri/src/pi-core-update.mjs';
import { normalizedState } from './composer-state.ts';

const release = (version = '1.4.0', extra = {}) => new Response(JSON.stringify({ version, ...extra }), { headers: { 'content-type': 'application/json' } });

test('Pi semantic versions compare releases, prereleases, numeric fields and build metadata', () => {
  for (const [left, right, expected] of [
    ['1.10.0', '1.9.0', 1], ['1.3.0', '1.4.0', -1], ['1.4.0', '1.4.0-rc.2', 1],
    ['1.4.0-rc.10', '1.4.0-rc.2', 1], ['1.4.0+build.1', '1.4.0+build.2', 0],
    ['1.4.0-alpha', '1.4.0-alpha.1', -1], ['1.4.0-1', '1.4.0-beta', -1],
  ]) assert.equal(comparePiVersions(left, right), expected);
  for (const bad of ['v1.4.0', '1.4', '01.4.0', '1.4.0-01', '<img src=x>', '1.4.0\n', '1.4.0+' ]) {
    assert.throws(() => comparePiVersions(bad, '1.3.0'));
  }
});

test('Pi version is read from the actual CLI package, not the easy_pi app package', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'pi-update-version-'));
  try {
    const pkg = join(scratch, 'pi');
    await mkdir(join(pkg, 'dist', 'bundle'), { recursive: true });
    await writeFile(join(scratch, 'package.json'), JSON.stringify({ name: 'pi-app', version: '9.9.9' }));
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0' }));
    const entry = join(pkg, 'dist', 'bundle', 'cli.js');
    await writeFile(entry, '// local version fixture');
    await symlink(entry, join(scratch, 'pi-link'));
    assert.equal(installedPiVersion(join(scratch, 'pi-link')), '1.3.0');
    assert.equal(installedPiVersion(join(scratch, 'package.json')), '');
    assert.equal(installedPiVersion(join(scratch, 'missing')), '');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('update checks only request fixed public metadata and discard remote commands, URLs and notes', async () => {
  const calls = [], changes = [];
  const checker = createPiUpdateChecker({ currentVersion: '1.3.0', env: {}, now: () => 1000,
    changed: state => changes.push(state), fetch: async (...args) => {
      calls.push(args);
      return release('1.4.0', { url: 'https://untrusted.invalid', note: '<img src=x>', command: 'untrusted command' });
    } });
  try {
    const result = await checker.check();
    assert.equal(result.status, 'available');
    assert.equal(result.currentVersion, '1.3.0');
    assert.equal(result.latestVersion, '1.4.0');
    assert.equal(result.checkedAt, 1000);
    assert.equal(calls[0][0], PI_VERSION_URL);
    assert.deepEqual(calls[0][1].headers, { accept: 'application/json' });
    assert.equal(calls[0][1].credentials, 'omit');
    assert.equal(calls[0][1].redirect, 'error');
    assert.equal(JSON.stringify(result).includes('untrusted'), false);
    assert.deepEqual(changes.map(value => value.status), ['checking', 'available']);
  } finally { checker.dispose(); }
});

test('parallel checks share a request, successful checks cache, and explicit checks refresh', async () => {
  let complete, calls = 0, now = 1000;
  const checker = createPiUpdateChecker({ currentVersion: '1.3.0', env: {}, ttlMs: 100,
    now: () => now, fetch: () => { calls++; return new Promise(resolve => { complete = resolve; }); } });
  try {
    const first = checker.check(), second = checker.check({ force: true });
    assert.equal(first, second);
    complete(release()); await first;
    await checker.check(); assert.equal(calls, 1);
    const forced = checker.check({ force: true });
    complete(release()); await forced;
    assert.equal(calls, 2);
    now += 101;
    const expired = checker.check();
    complete(release()); await expired;
    assert.equal(calls, 3);
  } finally { checker.dispose(); }
});

test('same, older and build-only versions never recommend an upgrade', async () => {
  for (const version of ['1.3.0', '1.2.0', '1.3.0+build.2', '1.3.0-rc.1']) {
    const checker = createPiUpdateChecker({ currentVersion: '1.3.0', env: {}, fetch: async () => release(version) });
    assert.equal((await checker.check()).status, 'current'); checker.dispose();
  }
});

test('offline and disabled checks never contact the network, including explicit checks', async () => {
  for (const env of [{ PI_OFFLINE: '1' }, { PI_SKIP_VERSION_CHECK: '1' }]) {
    const checker = createPiUpdateChecker({ currentVersion: '1.3.0', env,
      fetch: () => assert.fail('disabled checks must not fetch') });
    assert.equal((await checker.check({ force: true })).status, 'disabled'); checker.dispose();
  }
  const unavailable = createPiUpdateChecker({ currentVersion: '', env: {}, fetch: () => assert.fail('unknown core version') });
  assert.equal((await unavailable.check()).status, 'unavailable'); unavailable.dispose();
});

test('invalid, oversized and failing responses never become update notices or expose response text', async () => {
  for (const response of [
    () => release('<img src=x>'), () => new Response('private server error', { status: 503 }),
    () => new Response('{invalid private data'), () => new Response('x'.repeat(32769)),
    () => new Response('{}', { headers: { 'content-length': '40000' } }),
    () => new Response(new Uint8Array([0xff, 0xfe])),
  ]) {
    const checker = createPiUpdateChecker({ currentVersion: '1.3.0', env: {}, fetch: async () => response() });
    const result = await checker.check();
    assert.equal(result.status, 'error');
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(result.latestVersion, ''); checker.dispose();
  }
});

test('invalid UTF-8 metadata is classified as invalid rather than a connection failure', async () => {
  const checker = createPiUpdateChecker({ currentVersion: '1.3.0', env: {},
    fetch: async () => new Response(new Uint8Array([0xff])) });
  try { assert.equal((await checker.check()).error, 'invalid'); }
  finally { checker.dispose(); }
});

test('a blocked network check times out and disposal ignores late results', async () => {
  const checker = createPiUpdateChecker({ currentVersion: '1.3.0', env: {}, timeoutMs: 10, fetch: () => new Promise(() => {}) });
  assert.equal((await checker.check()).error, 'timeout'); checker.dispose();
  let finish; const changes = [];
  const disposed = createPiUpdateChecker({ currentVersion: '1.3.0', env: {}, changed: state => changes.push(state),
    fetch: () => new Promise(resolve => { finish = resolve; }) });
  const pending = disposed.check(); disposed.dispose(); await pending;
  finish(release()); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(changes.map(value => value.status), ['checking']);
});

test('normalizing workbench state preserves bounded update metadata without changing input readiness', () => {
  const coreUpdate = { status: 'available', currentVersion: '1.3.0', latestVersion: '1.4.0', checkedAt: 1 };
  const state = normalizedState({ connected: true, ready: true, busy: false, coreUpdate });
  assert.equal(state.ready, true); assert.deepEqual(state.coreUpdate, coreUpdate);
});
