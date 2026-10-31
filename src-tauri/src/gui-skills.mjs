import { constants } from "node:fs";
import { mkdir, open, rename, lstat, unlink, readdir, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { guiSkillsDirectory } from "./pi-paths.mjs";
import { rankTaskCandidates } from "./task-routing.mjs";
import { safeUserError } from "./privacy.mjs";

const MiB = 1024 * 1024;
const LIMIT = Object.freeze({ skills: 128, files: 256, file: 5 * MiB, skill: 256 * 1024, bundle: 20 * MiB, store: 256 * MiB, registry: 12 * MiB, jobs: 4, memory: 80 * MiB, ttl: 15 * 60 * 1000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const empty = () => ({ version: 1, revision: 0, skills: [] });
const abort = (signal) => { if (signal?.aborted) throw new Error("Skill operation cancelled."); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function text(value, max, label = "Value", allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || Buffer.byteLength(value) > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`${label} is invalid or exceeds its limit.`);
  return value;
}
function fileText(bytes) {
  if (bytes.byteLength > MiB) throw new Error("Only text skill files up to 1 MiB can be read through the library.");
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text(content, MiB, "Skill text", true);
  } catch { throw new Error("Binary skill files are not returned through the library."); }
}
function safePath(value, allowEmpty = false) {
  text(value, 512, "Skill path", allowEmpty);
  if (allowEmpty && value === "") return value;
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Unsafe skill path.");
  const parts = value.split("/");
  if (parts.length > 16 || parts.some((part) => !part || part === "." || part === ".." || /[\\:%<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || value !== value.normalize("NFC")) throw new Error("Unsafe skill path.");
  return value;
}
const canonical = (value) => `${value.owner.toLowerCase()}/${value.repo.toLowerCase()}/${value.path}`;
function httpsUrl(value, label) {
  text(value, 2048, label);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) throw new Error(`${label} must be a public HTTPS URL without credentials.`);
  return url.href;
}
function identity(value) {
  text(value.source, 64, "Source");
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(value.source) || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(value.owner) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(value.repo) || [".", ".."].includes(value.repo) || !COMMIT.test(value.commit)) throw new Error("Skill source is not pinned to a valid repository commit.");
  safePath(value.path, true);
  const repoUrl = httpsUrl(value.repoUrl, "Repository URL");
  if (repoUrl.toLowerCase().replace(/\/$/, "") !== `https://github.com/${value.owner}/${value.repo}`.toLowerCase()) throw new Error("Repository URL does not match the skill source.");
  return { source: value.source, url: httpsUrl(value.url, "Skill URL"), repoUrl, owner: value.owner, repo: value.repo, commit: value.commit, path: value.path };
}

// This deliberately accepts only scalar YAML for descriptive fields. All other
// frontmatter is removed from the runtime copy, including nested execution controls.
function scalar(raw, label) {
  raw = raw.trim();
  if (!raw) return "";
  if (raw.startsWith('"')) {
    const match = raw.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
    if (!match) throw new Error(`Invalid quoted YAML ${label}.`);
    try { const result = JSON.parse(match[1]); return text(result, 4096, label, true); }
    catch { throw new Error(`Invalid quoted YAML ${label}.`); }
  }
  if (raw.startsWith("'")) {
    const match = raw.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    if (!match) throw new Error(`Invalid quoted YAML ${label}.`);
    return match[1].replace(/''/g, "'");
  }
  if (/^[!&*[{>|%@`]/.test(raw) || /:\s/.test(raw) || /^(?:null|true|false|~|[-+]?\d+(?:\.\d+)?)$/i.test(raw)) throw new Error(`YAML ${label} must be a string scalar.`);
  return raw.replace(/\s+#.*$/, "").trim();
}
function parseSkill(bytes) {
  if (bytes.byteLength > LIMIT.skill) throw new Error("SKILL.md exceeds 256 KiB.");
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("SKILL.md must be UTF-8 text."); }
  text(content, LIMIT.skill, "SKILL.md");
  const start = content.match(/^﻿?---[ \t]*\r?\n/);
  if (!start) throw new Error("SKILL.md requires YAML name and description frontmatter.");
  const rest = content.slice(start[0].length);
  const end = /^---[ \t]*\r?$/m.exec(rest);
  if (!end) throw new Error("SKILL.md frontmatter is not closed.");
  const lines = rest.slice(0, end.index).split(/\r?\n/);
  const result = {};
  const keys = new Set();
  const stripped = [];
  const safe = new Set(["name", "description", "license", "compatibility"]);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) throw new Error("Unsupported YAML frontmatter indentation.");
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+([\s\S]*)|[ \t]*)$/);
    if (!match || keys.has(match[1])) throw new Error("Invalid or duplicate YAML frontmatter field.");
    const key = match[1]; keys.add(key);
    let raw = match[2] || "";
    const children = [];
    while (i + 1 < lines.length && (!lines[i + 1].trim() || /^[ \t]/.test(lines[i + 1]))) children.push(lines[++i]);
    if (!safe.has(key)) { stripped.push(key); continue; }
    const block = raw.match(/^([|>])([+-]?)([1-9]?)(?:[ \t]+#.*)?$/);
    if (block) {
      if (children.some((child) => /^\t/.test(child))) throw new Error("Tabs are not supported in YAML block indentation.");
      const nonempty = children.filter((child) => child.trim());
      const indent = block[3] ? Number(block[3]) : Math.min(...nonempty.map((child) => child.match(/^ */)[0].length));
      if (nonempty.some((child) => child.match(/^ */)[0].length < indent)) throw new Error("Invalid YAML block indentation.");
      const parts = children.map((child) => child.trim() ? child.slice(indent) : "");
      while (parts.length && !parts.at(-1)) parts.pop();
      let value = "";
      for (let p = 0; p < parts.length; p++) {
        value += parts[p];
        if (p < parts.length - 1) value += block[1] === ">" && parts[p] && parts[p + 1] && !/^ /.test(parts[p]) && !/^ /.test(parts[p + 1]) ? " " : "\n";
      }
      result[key] = value + (block[2] === "-" || !parts.length ? "" : "\n");
    } else {
      const continuation = children.filter((child) => child.trim() && !/^\s*#/.test(child));
      if (continuation.length) {
        if (!raw.trim() || /^["']/.test(raw.trim()) || continuation.some((child) => /^\s*[-?]|:\s/.test(child))) throw new Error(`Unsupported YAML ${key} value.`);
        raw += " " + continuation.map((child) => child.trim()).join(" ");
      }
      result[key] = scalar(raw, key);
    }
  }
  const name = text(result.name, 64, "Skill name");
  if (!NAME.test(name)) throw new Error("Skill name must use lowercase letters, numbers and single hyphens (maximum 64 bytes).");
  safePath(name);
  const description = text(result.description?.trim(), 1024, "Skill description");
  if (result.license !== undefined) text(result.license, 1024, "License", true);
  if (result.compatibility !== undefined) text(result.compatibility, 500, "Compatibility", true);
  const after = end.index + end[0].length;
  const body = rest.slice(after).replace(/^\r?\n/, "");
  const header = Object.entries({ name, description, ...(result.license ? { license: result.license } : {}), ...(result.compatibility ? { compatibility: result.compatibility } : {}) }).map(([key, value]) => `${key}: ${Array.from(JSON.stringify(value), (character) => [0x85, 0x2028, 0x2029].includes(character.charCodeAt(0)) ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}` : character).join("")}`).join("\n");
  return { name, description, content, runtime: Buffer.from(`---\n${header}\n---\n${body}`), license: result.license || undefined, stripped };
}
function treeHash(files) {
  return digest(files.map((file) => `${file.path}\0${file.sha256}\0${file.executable ? "100755" : "100644"}\n`).join(""));
}
function legacyTreeHash(files) {
  return digest(files.map((file) => `${file.path}\0${file.sha256}\n`).join(""));
}
function validateBundle(input) {
  if (!object(input) || !Array.isArray(input.files) || !input.files.length || input.files.length > LIMIT.files) throw new Error("A skill bundle must contain 1–256 files.");
  const source = identity(input);
  const paths = new Set();
  let totalBytes = 0;
  const files = input.files.map((file) => {
    if (!object(file)) throw new Error("Invalid skill file.");
    const path = safePath(file.path);
    const key = path.toLowerCase();
    if (paths.has(key)) throw new Error("Duplicate or case-colliding skill paths.");
    paths.add(key);
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength > LIMIT.file) throw new Error("Skill files must be bytes and cannot exceed 5 MiB.");
    totalBytes += file.bytes.byteLength;
    if (totalBytes > LIMIT.bundle) throw new Error("Skill bundle exceeds 20 MiB.");
    const bytes = Buffer.from(file.bytes);
    const sha256 = digest(bytes);
    if (file.sha256 !== sha256 || file.executable !== undefined && typeof file.executable !== "boolean") throw new Error("Skill file checksum or executable metadata is invalid.");
    return { path, bytes, sha256, executable: file.executable === true };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const file of files) {
    const segments = file.path.split("/");
    for (let i = 1; i < segments.length; i++) if (paths.has(segments.slice(0, i).join("/").toLowerCase())) throw new Error("Skill file and directory paths collide.");
  }
  const root = files.find((file) => file.path === "SKILL.md");
  if (!root) throw new Error("Skill bundle requires a root SKILL.md.");
  if (files.some((file) => file.path !== "SKILL.md" && /(?:^|\/)SKILL\.md$/i.test(file.path))) throw new Error("Select one skill directory; nested SKILL.md files cannot be exposed to runtime discovery.");
  const parsed = parseSkill(root.bytes);
  if (totalBytes !== input.totalBytes || (treeHash(files) !== input.treeHash && (files.some((file) => file.executable) || legacyTreeHash(files) !== input.treeHash))) throw new Error("Skill bundle checksum or byte count mismatch.");
  const warnings = [];
  if (Array.isArray(input.warnings)) for (const warning of input.warnings.slice(0, 24)) if (typeof warning === "string") warnings.push(warning.slice(0, 500));
  if (parsed.stripped.length) warnings.push(`Runtime frontmatter removes: ${parsed.stripped.join(", ").slice(0, 500)}.`);
  const license = typeof input.license === "string" ? text(input.license, 2048, "License", true) : parsed.license;
  return { ...source, name: parsed.name, title: parsed.name, description: parsed.description, ...(license ? { license } : {}), files, treeHash: input.treeHash, totalBytes, runtime: parsed.runtime, content: parsed.content, warnings };
}
const manifest = (bundle) => bundle.files.map(({ path, bytes, sha256, executable }) => ({ path, size: bytes.length, sha256, runtimeSize: path === "SKILL.md" ? bundle.runtime.length : bytes.length, runtimeSha256: path === "SKILL.md" ? digest(bundle.runtime) : sha256, ...(executable ? { executable: true } : {}) }));
const publicFiles = (files) => files.map(({ path, size, sha256, executable }) => ({ path, size, sha256, ...(executable ? { executable: true } : {}) }));
function publicRecord(record, withFiles = true) {
  const { storageVersion, ownership, files, ...value } = record;
  return { ...value, ...(withFiles ? { files: publicFiles(files) } : {}) };
}
function validateRegistry(value) {
  const fail = () => { throw new Error("Skill registry is corrupt; no files have been changed."); };
  const hasOnly = (item, keys) => Object.keys(item).every((key) => keys.includes(key));
  if (!object(value) || !hasOnly(value, ["version", "revision", "skills"]) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.skills) || value.skills.length > LIMIT.skills) fail();
  const ids = new Set(), identities = new Set(), names = new Set();
  let bytes = 0;
  try {
    for (const record of value.skills) {
      if (!object(record) || !hasOnly(record, ["id", "storageVersion", "ownership", "source", "url", "repoUrl", "owner", "repo", "commit", "path", "name", "title", "description", "treeHash", "totalBytes", "enabled", "installedAt", "updatedAt", "files", "license"]) || !UUID.test(record.id) || ids.has(record.id) || !UUID.test(record.storageVersion) || !UUID.test(record.ownership) || !NAME.test(record.name) || Buffer.byteLength(record.name) > 64 || typeof record.enabled !== "boolean" || !Number.isSafeInteger(record.installedAt) || !Number.isSafeInteger(record.updatedAt) || record.installedAt < 0 || record.updatedAt < record.installedAt || !HASH.test(record.treeHash)) fail();
      identity(record); text(record.title, 240, "Title"); text(record.description, 1024, "Description");
      if (record.license !== undefined) text(record.license, 2048, "License", true);
      if (!Array.isArray(record.files) || !record.files.length || record.files.length > LIMIT.files) fail();
      const paths = new Set(); let size = 0;
      for (const file of record.files) {
        if (!object(file) || !hasOnly(file, ["path", "size", "sha256", "runtimeSize", "runtimeSha256", "executable"])) fail();
        safePath(file.path);
        if (paths.has(file.path.toLowerCase()) || file.executable !== undefined && typeof file.executable !== "boolean" || !HASH.test(file.sha256) || !HASH.test(file.runtimeSha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMIT.file || !Number.isSafeInteger(file.runtimeSize) || file.runtimeSize < 0 || file.runtimeSize > LIMIT.file || file.path === "SKILL.md" && (file.size > LIMIT.skill || file.runtimeSize > LIMIT.skill + 16 * 1024) || file.path !== "SKILL.md" && (file.size !== file.runtimeSize || file.sha256 !== file.runtimeSha256)) fail();
        paths.add(file.path.toLowerCase()); size += file.size; bytes += file.size + file.runtimeSize;
      }
      if (!record.files.some((file) => file.path === "SKILL.md") || size !== record.totalBytes || size > LIMIT.bundle || treeHash(record.files) !== record.treeHash && (record.files.some((file) => file.executable) || legacyTreeHash(record.files) !== record.treeHash) || identities.has(canonical(record)) || record.enabled && names.has(record.name)) fail();
      ids.add(record.id); identities.add(canonical(record)); if (record.enabled) names.add(record.name);
    }
    if (bytes > LIMIT.store) fail();
  } catch { fail(); }
  return value;
}

export function createSkillLibrary(options = {}) {
  const directory = resolve(options.directory || guiSkillsDirectory());
  const registryPath = join(directory, "registry.json");
  const versionsPath = join(directory, "versions");
  let sources = options.sources;
  async function getSources() {
    if (!sources) sources = (await import("./skill-sources.mjs")).createSkillSources({ fetcher: options.fetcher });
    return sources;
  }
  let queue = Promise.resolve();
  const jobs = new Map();
  const previews = new Map();
  const versionPath = (record) => join(versionsPath, record.id, record.storageVersion);
  const skillPath = (record, runtime = false) => join(versionPath(record), runtime ? "runtime" : "original", record.name);
  const enqueue = (operation) => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
  async function directoryOnly(path, missing = false) {
    try { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Skill storage directories cannot be symlinks or files."); return stat; }
    catch (error) { if (missing && error.code === "ENOENT") return null; throw error; }
  }
  async function ensureRoot() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await directoryOnly(directory);
  }
  async function ensureChild(path, created) {
    let fresh = false;
    try { await mkdir(path, { mode: 0o700 }); fresh = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await directoryOnly(path);
    if (fresh && created) created.push({ path, stat, directory: true });
  }
  async function readBytes(path, max, expectedSize) {
    // lstat also enforces this boundary where O_NOFOLLOW is unavailable (Windows).
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > max) throw new Error("Skill file is unsafe, modified or exceeds its limit.");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > max || expectedSize !== undefined && stat.size !== expectedSize) throw new Error("Skill file is unsafe, modified or exceeds its limit.");
      const chunks = []; let length = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, max + 1 - length));
        const { bytesRead } = await handle.read(chunk);
        if (!bytesRead) break;
        length += bytesRead;
        if (length > max) throw new Error("Skill file exceeds its limit.");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      if (expectedSize !== undefined && length !== expectedSize) throw new Error("Skill file was modified.");
      return Buffer.concat(chunks, length);
    } finally { await handle.close(); }
  }
  async function load() {
    if (!await directoryOnly(directory, true)) return empty();
    let bytes;
    try { bytes = await readBytes(registryPath, LIMIT.registry); }
    catch (error) { if (error.code === "ENOENT") return empty(); throw error; }
    try { return validateRegistry(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
    catch { throw new Error("Skill registry is corrupt; no files have been changed."); }
  }
  async function writeNew(path, bytes, created, mode = 0o600) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try { if (created) created.push({ path, stat: await handle.stat(), directory: false }); await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  }
  async function save(value) {
    validateRegistry(value);
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (bytes.length > LIMIT.registry) throw new Error("Skill registry exceeds its limit.");
    await directoryOnly(directory);
    const temporary = join(directory, `.registry-${randomUUID()}.tmp`);
    await writeNew(temporary, bytes);
    try {
      // Never replace a symlink, special file, or an unvalidated existing registry.
      await load();
      await rename(temporary, registryPath);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async function locked(operation, signal) {
    abort(signal); await ensureRoot();
    const lockPath = join(directory, ".write-lock");
    let handle, inode;
    for (let attempt = 0; attempt < 160; attempt++) {
      abort(signal);
      try {
        handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        inode = await handle.stat();
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        break;
      } catch (error) {
        if (handle) { await handle.close().catch(() => {}); await unlink(lockPath).catch(() => {}); throw error; }
        if (error.code !== "EEXIST") throw error;
        let observed;
        try {
          const stat = observed = await lstat(lockPath);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe skill store lock.");
          const lockBytes = await readBytes(lockPath, 512);
          // The creating process may not have written its PID yet.
          if (!lockBytes.length && Date.now() - stat.mtimeMs < 5000) { await new Promise((done) => setTimeout(done, 25)); continue; }
          let previous;
          try { previous = JSON.parse(lockBytes.toString("utf8")); } catch { throw new Error("Invalid skill store lock; inspect it manually."); }
          if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error("Invalid skill store lock; inspect it manually.");
          let dead = false;
          try { process.kill(previous.pid, 0); } catch (failure) { if (failure.code === "ESRCH") dead = true; else if (failure.code !== "EPERM") throw failure; }
          if (dead) {
            const current = await lstat(lockPath);
            if (current.ino === stat.ino && current.dev === stat.dev) await unlink(lockPath);
            continue;
          }
        } catch (failure) {
          if (failure.code === "ENOENT") continue;
          // Another window can release/replace its lock between lstat and the
          // guarded open. Retry only when that exact inode has gone away; a stable
          // unsafe lock must still fail instead of being silently ignored.
          if (observed) {
            const current = await lstat(lockPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
            if (!current || current.ino !== observed.ino || current.dev !== observed.dev) continue;
          }
          throw failure;
        }
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    if (!handle) throw new Error("Skill store is busy in another window; try again.");
    try { abort(signal); return await operation(); }
    finally {
      await handle.close();
      const stat = await lstat(lockPath).catch(() => null);
      if (stat?.ino === inode.ino && stat?.dev === inode.dev) await unlink(lockPath).catch(() => {});
    }
  }
  async function assertVersion(record) {
    await directoryOnly(directory); await directoryOnly(versionsPath); await directoryOnly(join(versionsPath, record.id)); await directoryOnly(versionPath(record));
    const marker = JSON.parse((await readBytes(join(versionPath(record), ".owned.json"), 2048)).toString("utf8"));
    if (marker.version !== 1 || marker.id !== record.id || marker.storageVersion !== record.storageVersion || marker.name !== record.name || marker.treeHash !== record.treeHash || marker.ownership !== record.ownership) throw new Error("Skill version ownership does not match; files were preserved.");
    const entries = await readdir(versionPath(record));
    if (entries.length !== 3 || !entries.includes(".owned.json") || !entries.includes("original") || !entries.includes("runtime")) throw new Error("Skill version contains untracked local files.");
  }
  async function verifyTree(root, files, runtime) {
    await directoryOnly(root);
    const expected = new Map(files.map((file) => [file.path, file]));
    const dirs = new Set();
    for (const file of files) { const parts = file.path.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/")); }
    const seen = new Set();
    async function visit(path, prefix = "") {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const rel = prefix + entry.name, full = join(path, entry.name);
        const stat = await lstat(full);
        if (stat.isSymbolicLink()) throw new Error("Skill contains a symlink; local files were preserved.");
        if (stat.isDirectory()) { if (!dirs.has(rel)) throw new Error("Skill contains untracked local directories."); await visit(full, rel + "/"); }
        else {
          const file = expected.get(rel);
          if (!file || !stat.isFile()) throw new Error("Skill contains untracked local files.");
          const expectedMode = file.executable ? 0o700 : 0o600;
          if (process.platform !== "win32" && (stat.mode & 0o777) !== expectedMode) throw new Error("Skill file permissions do not match its executable metadata; local files were preserved.");
          const bytes = await readBytes(full, LIMIT.file, runtime ? file.runtimeSize : file.size);
          if (digest(bytes) !== (runtime ? file.runtimeSha256 : file.sha256)) throw new Error("Skill was modified locally; local files were preserved.");
          seen.add(rel);
        }
      }
    }
    await visit(root);
    if (seen.size !== files.length) throw new Error("Skill files are missing or modified locally.");
  }
  async function verifyVersion(record) {
    await assertVersion(record);
    for (const kind of ["original", "runtime"]) {
      await directoryOnly(join(versionPath(record), kind));
      const entries = await readdir(join(versionPath(record), kind));
      if (entries.length !== 1 || entries[0] !== record.name) throw new Error("Skill version contains untracked local files.");
    }
    await verifyTree(skillPath(record), record.files, false);
    await verifyTree(skillPath(record, true), record.files, true);
    const original = record.files.find((file) => file.path === "SKILL.md");
    const parsed = parseSkill(await readBytes(join(skillPath(record), "SKILL.md"), LIMIT.skill, original.size));
    if (parsed.name !== record.name || parsed.description !== record.description || digest(parsed.runtime) !== original.runtimeSha256 || parsed.runtime.length !== original.runtimeSize) throw new Error("Skill runtime metadata does not match its safe derived content.");
    if (record.files.some((file) => file.path !== "SKILL.md" && /(?:^|\/)SKILL\.md$/i.test(file.path))) throw new Error("Nested SKILL.md files cannot be exposed to runtime discovery.");
  }
  async function storageBytes() {
    if (!await directoryOnly(versionsPath, true)) return 0;
    let bytes = 0, entries = 0;
    async function visit(path, depth) {
      if (depth > 24) throw new Error("Skill storage contains unexpected directories.");
      for (const name of await readdir(path)) {
        if (++entries > 200000) throw new Error("Skill storage contains too many files.");
        const full = join(path, name), stat = await lstat(full);
        if (stat.isSymbolicLink()) throw new Error("Skill storage contains a symlink; files were preserved.");
        if (stat.isDirectory()) await visit(full, depth + 1);
        else if (stat.isFile() && stat.nlink === 1) { bytes += stat.size; if (bytes > LIMIT.store) throw new Error("Skill storage exceeds 256 MiB."); }
        else throw new Error("Skill storage contains an unsafe file.");
      }
    }
    await visit(versionsPath, 0); return bytes;
  }
  async function writeTree(root, bundle, runtime, created, signal) {
    await ensureChild(root, created);
    for (const file of bundle.files) {
      abort(signal);
      const parts = file.path.split("/"); let path = root;
      for (const part of parts.slice(0, -1)) { path = join(path, part); await ensureChild(path, created); }
      await writeNew(join(path, parts.at(-1)), runtime && file.path === "SKILL.md" ? bundle.runtime : file.bytes, created, file.executable ? 0o700 : 0o600);
    }
  }
  // Deletion uses an explicit checked file list. It never recursively follows or
  // removes unknown paths, even if a registry or local directory was tampered with.
  async function deleteVersion(record) {
    await verifyVersion(record);
    for (const runtime of [false, true]) {
      const root = skillPath(record, runtime);
      const dirs = new Set();
      for (const file of record.files) {
        const parts = file.path.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
        await unlink(join(root, file.path));
      }
      for (const path of [...dirs].sort((a, b) => b.split("/").length - a.split("/").length)) await rmdir(join(root, path));
      await rmdir(root); await rmdir(join(versionPath(record), runtime ? "runtime" : "original"));
    }
    await unlink(join(versionPath(record), ".owned.json"));
    await rmdir(versionPath(record));
    await rmdir(join(versionsPath, record.id)).catch((error) => { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
  }
  async function createVersion(record, bundle, signal) {
    const created = [];
    try {
      await ensureChild(versionsPath); await ensureChild(join(versionsPath, record.id), created);
      // UUID version paths are exclusive; never adopt an existing directory.
      await mkdir(versionPath(record), { mode: 0o700 });
      created.push({ path: versionPath(record), stat: await lstat(versionPath(record)), directory: true });
      await writeNew(join(versionPath(record), ".owned.json"), Buffer.from(JSON.stringify({ version: 1, id: record.id, storageVersion: record.storageVersion, ownership: record.ownership, name: record.name, treeHash: record.treeHash })), created);
      await ensureChild(join(versionPath(record), "original"), created); await ensureChild(join(versionPath(record), "runtime"), created);
      await writeTree(skillPath(record), bundle, false, created, signal); await writeTree(skillPath(record, true), bundle, true, created, signal);
      await verifyVersion(record); abort(signal);
    } catch (error) {
      // Roll back only entries created by this attempt, with unchanged identity.
      for (const entry of created.reverse()) {
        const stat = await lstat(entry.path).catch(() => null);
        if (stat && !stat.isSymbolicLink() && stat.ino === entry.stat.ino && stat.dev === entry.stat.dev) await (entry.directory ? rmdir(entry.path) : unlink(entry.path)).catch(() => {});
      }
      throw error;
    }
  }
  function release(job) {
    if (job?.token) { previews.delete(job.token); delete job.token; }
  }
  function cleanup() {
    const now = Date.now();
    for (const [token, preview] of previews) if (preview.expires <= now) {
      previews.delete(token);
      const job = jobs.get(preview.jobId);
      if (job?.state === "ready") { job.state = "failed"; job.error = "Skill preview expired; preview again."; delete job.preview; delete job.token; }
    }
  }
  function progress(value) {
    value = { ...value, files: value?.files ?? value?.completed, totalFiles: value?.totalFiles ?? value?.total, bytes: value?.bytes ?? value?.totalBytes };
    const result = { phase: typeof value?.phase === "string" ? value.phase.slice(0, 64) : "downloading" };
    for (const key of ["files", "totalFiles"]) if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = Math.min(value[key], LIMIT.files);
    for (const key of ["bytes", "totalBytes"]) if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = Math.min(value[key], LIMIT.bundle);
    if (typeof value?.message === "string") result.message = value.message.slice(0, 240).replace(/[\x00-\x1f\x7f]/g, " ");
    return result;
  }
  function jobResult(job) {
    return { id: job.id, state: job.state, progress: { ...job.progress }, ...(job.preview ? { preview: structuredClone(job.preview) } : {}), ...(job.error ? { error: job.error } : {}) };
  }
  function startPreview(request, signal, previous, oldRevision) {
    cleanup(); abort(signal);
    while (jobs.size >= LIMIT.jobs) {
      const terminal = [...jobs.values()].find((job) => job.state !== "running");
      if (!terminal) throw new Error("At most four skill previews may run at once.");
      release(terminal); jobs.delete(terminal.id);
    }
    const controller = new AbortController();
    const job = { id: randomUUID(), state: "running", progress: { phase: "resolving" }, controller };
    const cancel = () => { if (job.state === "running" || job.state === "ready") { controller.abort(); release(job); delete job.preview; job.state = "cancelled"; job.progress = { phase: "cancelled" }; } };
    job.cancel = cancel;
    signal?.addEventListener("abort", cancel, { once: true });
    jobs.set(job.id, job);
    const sourceRequest = previous ? { source: previous.source, url: previous.url, latest: true, entry: { owner: previous.owner, repo: previous.repo, repoUrl: previous.repoUrl, path: previous.path } } : { source: request.source, ...(request.url ? { url: request.url } : {}), ...(request.entry ? { entry: request.entry } : {}) };
    Promise.resolve().then(async () => {
      try {
        abort(controller.signal);
        const downloaded = await (await getSources()).resolveBundle({ ...sourceRequest, signal: controller.signal, onProgress: (value) => { if (job.state === "running") job.progress = progress(value); } });
        abort(controller.signal);
        const bundle = validateBundle(downloaded);
        if (previous && (canonical(bundle) !== canonical(previous) || bundle.source !== previous.source)) throw new Error("Update resolved a different canonical skill or source.");
        cleanup();
        const memory = [...previews.values()].reduce((sum, item) => sum + item.bundle.totalBytes, 0);
        if (previews.size >= LIMIT.jobs || memory + bundle.totalBytes > LIMIT.memory) throw new Error("Skill preview memory limit reached; cancel an older preview.");
        abort(controller.signal);
        const token = randomUUID();
        const hash = digest(JSON.stringify({ identity: canonical(bundle), commit: bundle.commit, treeHash: bundle.treeHash, ...(previous ? { id: previous.id, storageVersion: previous.storageVersion, oldRevision } : {}) }));
        const preview = { token, hash, source: bundle.source, url: bundle.url, repoUrl: bundle.repoUrl, owner: bundle.owner, repo: bundle.repo, commit: bundle.commit, path: bundle.path, name: bundle.name, title: bundle.title, description: bundle.description, treeHash: bundle.treeHash, totalBytes: bundle.totalBytes, files: publicFiles(manifest(bundle)), warnings: bundle.warnings, content: bundle.content, ...(bundle.license ? { license: bundle.license } : {}), ...(previous ? { updateId: previous.id } : {}) };
        previews.set(token, { bundle, hash, expires: Date.now() + LIMIT.ttl, jobId: job.id, previous, oldRevision });
        job.token = token; job.preview = preview; job.state = "ready";
        job.progress = { phase: "ready", files: bundle.files.length, totalFiles: bundle.files.length, bytes: bundle.totalBytes, totalBytes: bundle.totalBytes };
      } catch (error) {
        release(job); delete job.preview;
        if (controller.signal.aborted) { job.state = "cancelled"; job.progress = { phase: "cancelled" }; }
        else { job.state = "failed"; job.error = safeUserError(error, "Skill preview failed.", 1000); job.progress = { phase: "failed" }; }
      } finally { signal?.removeEventListener("abort", cancel); }
    });
    return { jobId: job.id };
  }
  function find(value, id) {
    if (!UUID.test(id || "")) throw new Error("Invalid installed skill ID.");
    const record = value.skills.find((skill) => skill.id === id);
    if (!record) throw new Error("Installed skill does not exist.");
    return record;
  }
  async function read(request) {
    const record = find(await load(), request.id);
    await assertVersion(record);
    const path = request.path === undefined ? "SKILL.md" : safePath(request.path);
    const file = record.files.find((item) => item.path === path);
    if (!file) throw new Error("Skill file does not exist.");
    if (file.size > MiB) throw new Error("Only text skill files up to 1 MiB can be read through the library.");
    const root = skillPath(record);
    await directoryOnly(join(versionPath(record), "original")); await directoryOnly(root);
    let parent = root;
    for (const part of path.split("/").slice(0, -1)) { parent = join(parent, part); await directoryOnly(parent); }
    const bytes = await readBytes(join(root, path), MiB, file.size);
    if (digest(bytes) !== file.sha256) throw new Error("Skill was modified locally; stored checksum does not match.");
    const content = fileText(bytes);
    return { skill: publicRecord(record), content, files: publicFiles(record.files), path };
  }
  async function taskSkill(id) {
    return enqueue(async () => {
      const record = find(await load(), id);
      await assertVersion(record);
      const item = await read({ id, path: "SKILL.md" });
      return { skill: publicRecord(record, false), path: skillPath(record, true), content: item.content };
    });
  }
  async function install(request, signal, isAuthorized = async () => true) {
    if (request.accepted !== true) throw new Error("Read and accept the complete preview before installing a skill.");
    cleanup();
    const preview = previews.get(request.token);
    if (!preview || preview.expires <= Date.now()) throw new Error("Skill preview expired or was cancelled; preview again.");
    if (request.hash !== preview.hash) throw new Error("Skill preview hash mismatch; preview again.");
    const value = await load();
    const { bundle, previous, oldRevision } = preview;
    let old;
    if (previous) {
      old = find(value, previous.id);
      if (value.revision !== oldRevision || old.storageVersion !== previous.storageVersion || old.treeHash !== previous.treeHash) throw new Error("Installed skill changed after preview; preview the update again.");
      await verifyVersion(old);
    } else if (value.skills.some((record) => canonical(record) === canonical(bundle))) throw new Error("This canonical skill is already installed (including through another source).");
    if (!old && value.skills.length >= LIMIT.skills) throw new Error("At most 128 skills can be installed.");
    if (old?.enabled && value.skills.some((record) => record.id !== old.id && record.enabled && record.name === bundle.name)) throw new Error("An enabled skill already uses this name.");
    const now = Date.now();
    const record = { id: old?.id || randomUUID(), storageVersion: randomUUID(), ownership: randomUUID(), source: bundle.source, url: bundle.url, repoUrl: bundle.repoUrl, owner: bundle.owner, repo: bundle.repo, commit: bundle.commit, path: bundle.path, name: bundle.name, title: bundle.title, description: bundle.description, treeHash: bundle.treeHash, totalBytes: bundle.totalBytes, enabled: old?.enabled || false, installedAt: old?.installedAt || now, updatedAt: Math.max(now, old?.updatedAt || 0), files: manifest(bundle), ...(bundle.license ? { license: bundle.license } : {}) };
    const incoming = record.files.reduce((sum, file) => sum + file.size + file.runtimeSize, 0) + 2048;
    if (await storageBytes() + incoming > LIMIT.store) throw new Error("Skill storage exceeds 256 MiB (including the retained update version).");
    abort(signal);
    if (!await isAuthorized()) throw new Error("Download authorization was revoked before installation.");
    await createVersion(record, bundle, signal);
    try {
      abort(signal);
      if (!await isAuthorized()) throw new Error("Download authorization was revoked before installation committed.");
      if (previews.get(request.token) !== preview || preview.expires <= Date.now()) throw new Error("Skill preview expired or was cancelled before installation committed.");
      if (old) value.skills[value.skills.indexOf(old)] = record; else value.skills.push(record);
      value.revision++; await save(value);
    } catch (error) { await deleteVersion(record).catch(() => {}); throw error; }
    release(jobs.get(preview.jobId));
    const job = jobs.get(preview.jobId);
    if (job) { job.state = "failed"; job.error = "Preview has been installed; preview again to reinstall."; delete job.preview; }
    // Other services/Pi processes may still use cached paths, even after disabling
    // or restarting this service. Retain every retired version; storageBytes counts
    // them toward the store limit. GC requires proof that no process can use them.
    const warnings = old ? ["Previous skill files were retained because running Pi tasks may still use them. Retained files count toward the 256 MiB storage limit; automatic cleanup is not performed."] : [];
    return { skill: publicRecord(record), revision: value.revision, reloadRequired: true, ...(warnings.length ? { warnings } : {}) };
  }
  async function waitForPreview(jobId, signal) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      abort(signal);
      const job = jobs.get(jobId);
      if (!job) throw new Error("Automatic Skill preview was evicted.");
      if (job.state === "ready") return job;
      if (job.state !== "running") throw new Error(job.error || "Automatic Skill preview failed.");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", stop);
          resolve();
        }, 40);
        const stop = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          reject(signal.reason || new Error("Skill operation cancelled."));
        };
        signal?.addEventListener("abort", stop, { once: true });
      });
    }
    throw new Error("Automatic Skill preview timed out.");
  }
  async function autoInstallForTask({ task, isAuthorized = async () => false, signal } = {}) {
    const allowed = async () => {
      abort(signal);
      return await isAuthorized();
    };
    if (!task?.shouldSearchCatalog || !task.searchTerms?.length || !await allowed()) return null;
    const catalogs = await (await getSources()).search({
      source: "all",
      query: task.searchTerms[0],
      page: 1,
      signal,
    });
    const candidate = rankTaskCandidates(task, catalogs.entries, 4)
      .find(({ candidate: item }) => item?.url && item?.source)?.candidate;
    if (!candidate || !await allowed()) return null;
    const { jobId } = startPreview({ source: candidate.source, url: candidate.url, entry: candidate }, signal);
    let job;
    try { job = await waitForPreview(jobId, signal); }
    catch (error) { jobs.get(jobId)?.cancel?.(); throw error; }
    if (!await allowed()) { job.cancel?.(); return null; }
    const installed = await enqueue(() => locked(async () => {
      if (!await allowed()) return null;
      return install({ token: job.token, hash: job.preview.hash, accepted: true }, signal, allowed);
    }, signal));
    return installed?.skill?.id ? taskSkill(installed.skill.id) : null;
  }
  function normalize(input) {
    if (typeof input === "string") { try { input = JSON.parse(input); } catch { throw new Error("Invalid skill request JSON."); } }
    if (!object(input) || typeof input.action !== "string") throw new Error("A skill action is required.");
    return { ...input, action: input.action.trim().toLowerCase() };
  }
  async function run(input, authority = "user", signal) {
    const request = normalize(input);
    if (authority !== "user" && !["list", "read", "status"].includes(request.action)) throw new Error("Skill networking and changes require a user action in the interface.");
    abort(signal);
    if (request.action === "list") return enqueue(async () => {
      const value = await load();
      const query = request.query === undefined ? "" : text(request.query, 500, "Query", true).trim().toLowerCase();
      return { skills: value.skills.filter((record) => !query || `${record.name} ${record.description} ${record.source}`.toLowerCase().includes(query)).map((record) => publicRecord(record, false)), revision: value.revision };
    });
    if (request.action === "read") return enqueue(() => read(request));
    if (request.action === "preview_read") {
      cleanup();
      const preview = previews.get(request.token);
      if (!preview || preview.expires <= Date.now()) throw new Error("Skill preview expired or was cancelled; preview again.");
      if (request.hash !== preview.hash) throw new Error("Skill preview hash mismatch; preview again.");
      const path = safePath(request.path);
      const file = preview.bundle.files.find((item) => item.path === path);
      if (!file) throw new Error("Skill file does not exist.");
      return { path, content: fileText(file.bytes) };
    }
    if (request.action === "status") return status();
    if (request.action === "browse") {
      const source = text(request.source ?? "all", 64, "Source").trim();
      const page = request.page === undefined ? 1 : Number(request.page);
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new Error("Invalid skill browse page.");
      if (request.refresh !== undefined && typeof request.refresh !== "boolean") throw new Error("refresh must be a boolean.");
      return (await getSources()).browse({ source, page, signal, refresh: request.refresh === true });
    }
    if (request.action === "search") {
      const source = text(request.source, 64, "Source").trim();
      const query = text(request.query ?? "", 500, "Query", true).trim();
      const page = request.page === undefined ? 1 : Number(request.page);
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new Error("Invalid skill search page.");
      const apiKey = request.apiKey === undefined ? undefined : text(request.apiKey, 4096, "API key").trim();
      if (request.refresh !== undefined && typeof request.refresh !== "boolean") throw new Error("refresh must be a boolean.");
      return (await getSources()).search({ source, query, page, signal, refresh: request.refresh === true, ...(apiKey ? { apiKey } : {}) });
    }
    if (request.action === "preview") return startPreview(request, signal);
    if (request.action === "update") return enqueue(async () => { const value = await load(); const record = find(value, request.id); await verifyVersion(record); return startPreview(request, signal, structuredClone(record), value.revision); });
    if (request.action === "job") { cleanup(); const job = jobs.get(request.jobId || request.id); if (!job) throw new Error("Skill preview job does not exist or was evicted."); return jobResult(job); }
    if (request.action === "cancel") { const job = jobs.get(request.jobId || request.id); if (!job) throw new Error("Skill preview job does not exist."); job.cancel(); return jobResult(job); }
    if (request.action === "install") return enqueue(() => locked(() => install(request, signal), signal));
    if (request.action === "enable") return enqueue(() => locked(async () => {
      if (typeof request.enabled !== "boolean") throw new Error("enabled must be a boolean.");
      const value = await load(), record = find(value, request.id);
      if (request.enabled) {
        await verifyVersion(record);
        if (value.skills.some((skill) => skill.id !== record.id && skill.enabled && skill.name === record.name)) throw new Error("An enabled skill already uses this name.");
      }
      abort(signal);
      if (record.enabled !== request.enabled) { record.enabled = request.enabled; value.revision++; await save(value); }
      return { enabled: record.enabled, skill: publicRecord(record), revision: value.revision, reloadRequired: true };
    }, signal));
    if (request.action === "remove") return enqueue(() => locked(async () => {
      if (request.accepted !== true) throw new Error("Confirm removal of this skill first.");
      const value = await load(), record = find(value, request.id);
      // Remove only the registry entry: even a disabled version may still be in
      // use by another Pi process. Preserve local edits and all retired files.
      abort(signal);
      value.skills = value.skills.filter((skill) => skill.id !== record.id); value.revision++; await save(value);
      return { removed: true, revision: value.revision, reloadRequired: true, warnings: ["Skill was removed from the library; its files were retained because running Pi tasks may still use them. Retained files count toward the 256 MiB storage limit; automatic cleanup is not performed."] };
    }, signal));
    throw new Error("Unknown skill action.");
  }
  async function enabledPaths() {
    return enqueue(async () => {
      const value = await load(), paths = [];
      for (const record of value.skills.filter((skill) => skill.enabled)) { await verifyVersion(record); paths.push(skillPath(record, true)); }
      return paths;
    });
  }
  async function enabledSkillSnapshot() {
    return enqueue(async () => {
      const value = await load(), paths = [];
      for (const record of value.skills.filter((skill) => skill.enabled)) {
        await verifyVersion(record);
        paths.push(skillPath(record, true));
      }
      return { revision: value.revision, paths };
    });
  }
  async function status() {
    return enqueue(async () => { const value = await load(); return { revision: value.revision, enabled: value.skills.filter((skill) => skill.enabled).map((skill) => skill.id), installed: value.skills.length }; });
  }
  function dispose() { for (const job of jobs.values()) job.cancel(); previews.clear(); jobs.clear(); }
  return { run, enabledPaths, enabledSkillSnapshot, taskSkill, autoInstallForTask, status, dispose };
}
