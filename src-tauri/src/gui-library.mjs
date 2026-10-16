import { constants } from "node:fs";
import { mkdir, open, rename, lstat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MARKET_CATALOG, marketEntry, contentHash } from "./gui-market.mjs";

const MAX_STORE = 10 * 1024 * 1024;
const MAX_AGENT = 256 * 1024;
const MAX_MEMORY = 64 * 1024;
const defaults = () => ({ version: 1, settings: { memoryEnabled: true, autonomousDownloads: true }, memories: [], agents: [] });
const text = (value, max) => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || /\0/.test(value)) throw new Error("内容为空或超过存储限制。");
  return value.trim();
};

export function agentDownloadUrl(value) {
  const url = new URL(text(value, 2000));
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) throw new Error("请选择公开 GitHub Agent 文件的 HTTPS 链接。");
  if (url.hostname === "github.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 5 || !["blob", "raw"].includes(segments[2])) throw new Error("请选择具体的 Markdown 文件，不能下载整个仓库。");
    url.hostname = "raw.githubusercontent.com";
    url.pathname = "/" + [segments[0], segments[1], ...segments.slice(3)].join("/");
  }
  if (url.hostname !== "raw.githubusercontent.com" || !/\.(md|txt)$/i.test(url.pathname)
    || url.pathname.split("/").some((part) => /[\\\0]/.test(decodeURIComponent(part)) || decodeURIComponent(part) === "..")) {
    throw new Error("仅支持公开 GitHub 上的 Markdown 或文本 Agent 定义。");
  }
  return url;
}

export async function fetchAgentDefinition(source, signal, fetcher = globalThis.fetch) {
  const url = agentDownloadUrl(source);
  const timeout = AbortSignal.timeout(12000);
  const response = await fetcher(url, {
    redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: "text/plain", "User-Agent": "Pi-GUI-Agent-Library" },
  });
  if (!response.ok || !response.body) throw new Error(`Agent 下载失败（HTTP ${response.status}）。`);
  if (Number(response.headers.get("content-length")) > MAX_AGENT) {
    await response.body.cancel(); throw new Error("Agent 文件不能超过 256 KB。");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AGENT) throw new Error("Agent 文件不能超过 256 KB。");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const content = text(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), MAX_AGENT);
  if (/^\s*(<!doctype|<html|<script)/i.test(content) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) {
    throw new Error("下载内容不是有效的文本 Agent 定义。");
  }
  return { source: url.href, content };
}

export function createAgentLibrary(options = {}) {
  const directory = options.directory || join(homedir(), ".pi", "agent", "gui-library");
  const filename = join(directory, "library.json");
  let queue = Promise.resolve();
  const marketPreviews = new Map();
  const ensureDirectory = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("记忆库目录不能是符号链接。");
  };
  const load = async () => {
    try {
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        if ((await file.stat()).size > MAX_STORE) throw new Error("记忆库超过 10 MB。");
        bytes = await file.readFile();
      } finally { await file.close(); }
      const value = JSON.parse(bytes.toString("utf8"));
      if (value?.version !== 1 || !value.settings || typeof value.settings.memoryEnabled !== "boolean"
        || typeof value.settings.autonomousDownloads !== "boolean" || !Array.isArray(value.memories) || !Array.isArray(value.agents)
        || value.memories.length > 100 || value.agents.length > 40) throw new Error("记忆库格式无效，原文件未改动。");
      // One damaged record must not hide the rest; it is set aside and written back untouched.
      const ids = new Set();
      const invalid = { memories: [], agents: [] };
      for (const list of ["memories", "agents"]) {
        value[list] = value[list].filter((item) => {
          try {
            if (!item || typeof item.id !== "string" || !/^[a-f0-9-]{36}$/.test(item.id) || ids.has(item.id)
              || !Number.isFinite(item.updatedAt) || (item.source !== undefined && typeof item.source !== "string")) throw new Error();
            text(item.title, 240); text(item.content, MAX_AGENT);
            ids.add(item.id); return true;
          } catch { invalid[list].push(item); return false; }
        });
      }
      Object.defineProperty(value, "invalid", { value: invalid, enumerable: false });
      // The active Agent is a user choice; a removed or damaged definition simply leaves none active.
      if (typeof value.settings.activeAgent !== "string" || !value.agents.some((item) => item.id === value.settings.activeAgent)) value.settings.activeAgent = "";
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return defaults();
      throw error;
    }
  };
  const save = async (value) => {
    const invalid = value.invalid || { memories: [], agents: [] };
    const stored = { ...value, memories: [...value.memories, ...invalid.memories], agents: [...value.agents, ...invalid.agents] };
    const bytes = Buffer.from(JSON.stringify(stored, null, 2) + "\n");
    if (bytes.length > MAX_STORE) throw new Error("记忆库超过 10 MB。");
    const temporary = join(directory, `.library-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, filename); }
    finally { await unlink(temporary).catch(() => {}); }
  };
  const locked = async (operation) => {
    await ensureDirectory();
    const lockPath = join(directory, ".write-lock");
    let lock;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { lock = await open(lockPath, "wx", 0o600); break; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const stat = await lstat(lockPath).catch((failure) => { if (failure.code === "ENOENT") return null; throw failure; });
        if (!stat) continue;
        if (!stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 60000) await unlink(lockPath);
        else await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!lock) throw new Error("记忆库正在由另一个窗口更新，请稍后重试。");
    try { return await operation(); }
    finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
  };
  const enqueue = (operation) => {
    const result = queue.then(operation);
    queue = result.then(() => {}, () => {});
    return result;
  };
  const run = (request, authority = "user", signal) => {
    if (request?.kind === "market") {
      if (authority !== "user") return Promise.reject(new Error("市场导入与启用只能由用户在界面操作。"));
      if (request.action === "list") return enqueue(async () => {
        const value = await load();
        const installed = value.agents.filter((item) => typeof item.marketKey === "string" && item.marketKey).map(({ id, marketKey, title, source, content }) => ({ id, marketKey, title, source, hash: contentHash(content) }));
        const external = value.agents.filter((item) => (typeof item.marketKey === "string" && item.marketKey.startsWith("github:"))).map((item) => ({
          id: "", installedId: item.id, title: item.title, category: "external", description: "Imported GitHub text Agent / 已导入的 GitHub 文本 Agent",
          author: "GitHub source", license: "See source", source: item.source, kind: "text-agent", hash: contentHash(item.content), marketKey: item.marketKey, version: "",
        }));
        return {
          entries: [...MARKET_CATALOG.map(({ content, ...item }) => ({ ...item, installedId: installed.find((record) => record.marketKey === item.marketKey)?.id || "" })), ...external],
          installed, activeAgent: value.settings.activeAgent || "",
        };
      });
      if (request.action === "preview") return (async () => {
        if (request.id) return { ...marketEntry(request.id) };
        if (request.installedId) {
          const value = await load();
          const item = value.agents.find((entry) => entry.id === request.installedId && (typeof entry.marketKey === "string" && entry.marketKey.startsWith("github:")));
          if (!item) throw Error("本地市场 Agent 不存在，请刷新。");
          return { ...item, id: "", installedId: item.id, category: "external", author: "GitHub source", license: "See source", kind: "text-agent", hash: contentHash(item.content), version: "" };
        }
        const downloaded = await fetchAgentDefinition(request.source, signal, options.fetcher);
        const now = Date.now();
        for (const [key, value] of marketPreviews) if (value.expires < now) marketPreviews.delete(key);
        if (marketPreviews.size >= 8) marketPreviews.delete(marketPreviews.keys().next().value);
        const token = randomUUID();
        const title = text(request.title || decodeURIComponent(new URL(downloaded.source).pathname.split("/").pop()).replace(/\.(md|txt)$/i, ""), 240);
        const entry = { ...downloaded, title, id: "", marketKey: `github:${downloaded.source}`, hash: contentHash(downloaded.content), kind: "text-agent", author: "GitHub source", license: "See source", category: "external", version: "" };
        marketPreviews.set(token, { entry, expires: now + 15 * 60 * 1000 });
        return { ...entry, token };
      })();
      if (request.action === "import") return enqueue(() => locked(async () => {
        if (request.accepted !== true) throw Error("请先阅读全文并确认导入。");
        let entry;
        if (request.id) entry = marketEntry(request.id);
        else {
          const preview = marketPreviews.get(request.token);
          if (!preview || preview.expires < Date.now()) throw Error("预览已过期，请重新预览后导入。");
          entry = preview.entry;
        }
        if (request.hash !== entry.hash) throw Error("预览内容校验不一致，请重新预览。");
        if (signal?.aborted) throw Error("市场导入已取消。");
        const value = await load();
        const existing = value.agents.find((item) => item.marketKey === entry.marketKey);
        if (existing) return { id: existing.id, alreadyImported: true };
        if (value.agents.length + (value.invalid?.agents.length || 0) >= 40) throw Error("最多保存 40 个 Agent，请先在本地库整理。");
        const item = { id: randomUUID(), title: text(entry.title, 240), content: text(entry.content, MAX_AGENT), source: entry.source, updatedAt: Date.now(), untrusted: true, marketKey: entry.marketKey, importedHash: entry.hash, marketVersion: entry.version || "" };
        value.agents.push(item); await save(value);
        return { id: item.id, alreadyImported: false };
      }));
      return Promise.reject(new Error("仅支持市场浏览、预览与文本导入。"));
    }
    // Network waits do not block a user's permission changes or local edits.
    if (request?.kind === "agent" && request.action === "download") {
      return (async () => {
        const before = await load();
        if (authority !== "user" && !before.settings.autonomousDownloads) throw new Error("用户已关闭模型自主下载 Agent。");
        const downloaded = await fetchAgentDefinition(request.source, signal, options.fetcher);
        return enqueue(() => locked(async () => {
          const value = await load();
          if (signal?.aborted) throw new Error("Agent 下载已取消。");
          if (authority !== "user" && !value.settings.autonomousDownloads) throw new Error("下载权限已撤销，文件未保存。");
          if (value.agents.length >= 40) throw new Error("最多保存 40 个 Agent。");
          const title = text(request.title || decodeURIComponent(new URL(downloaded.source).pathname.split("/").pop()).replace(/\.(md|txt)$/i, ""), 240);
          const item = { id: randomUUID(), title, ...downloaded, updatedAt: Date.now(), untrusted: true };
          value.agents.push(item); await save(value); return item;
        }));
      })();
    }
    return enqueue(async () => {
      if (!request || !["memory", "agent", "settings", "list", "context"].includes(request.kind)) throw new Error("未知的记忆库操作。");
      if (request.kind === "list") {
        const value = await load();
        const previews = (items) => items.map((item) => ({ ...item, content: item.content.slice(0, 160), preview: true }));
        const skipped = (value.invalid?.memories.length ?? 0) + (value.invalid?.agents.length ?? 0);
        return { ...value, memories: previews(value.memories), agents: previews(value.agents), ...(skipped ? { skipped } : {}) };
      }
      if (request.kind === "context") {
        // Full recent notes for prompt context; previews would cut every note at 160 characters.
        const value = await load();
        const memories = value.settings.memoryEnabled ? value.memories.slice().sort((a, b) => b.updatedAt - a.updatedAt) : [];
        const agent = value.agents.find((item) => item.id === value.settings.activeAgent);
        return { memoryEnabled: value.settings.memoryEnabled, memories: memories.slice(0, Math.min(Number(request.limit) || 8, 100)),
          agent: agent ? { id: agent.id, title: agent.title, content: agent.content, untrusted: !!agent.untrusted } : null };
      }
      return locked(async () => {
        const value = await load();
        if (request.kind === "settings") {
          if (authority !== "user") throw new Error("下载和记忆权限只能由用户更改。");
          if (typeof request.memoryEnabled === "boolean") value.settings.memoryEnabled = request.memoryEnabled;
          if (typeof request.autonomousDownloads === "boolean") value.settings.autonomousDownloads = request.autonomousDownloads;
          if (typeof request.activeAgent === "string") {
            if (request.activeAgent && !value.agents.some((item) => item.id === request.activeAgent)) throw new Error("记录不存在。");
            value.settings.activeAgent = request.activeAgent;
          }
          await save(value); return value.settings;
        }
        if (request.kind === "memory" && authority !== "user" && !value.settings.memoryEnabled) throw new Error("用户已关闭 Agent 记忆。");
        const items = request.kind === "memory" ? value.memories : value.agents;
        if (request.action === "list") {
          const query = typeof request.query === "string" ? request.query.toLowerCase().slice(0, 200) : "";
          return items.filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(query))
            .map(({ id, title, source, updatedAt }) => ({ id, title, source, updatedAt }));
        }
        const index = items.findIndex((item) => item.id === request.id);
        if (request.action === "read") {
          if (index < 0) throw new Error("记录不存在。"); return items[index];
        }
        if (request.action === "remove") {
          if (authority !== "user") throw new Error("删除库记录需要用户在设置中操作。");
          if (index < 0) throw new Error("记录不存在。");
          items.splice(index, 1);
          if (request.kind === "agent" && value.settings.activeAgent === request.id) value.settings.activeAgent = "";
          await save(value); return { removed: true };
        }
        if (request.action !== "save" || (request.id && index < 0)) throw new Error("无效的保存操作。");
        if (request.kind === "agent" && authority !== "user") throw new Error("Agent 定义只能由用户编辑；模型可以下载或读取。");
        if (index < 0 && items.length >= (request.kind === "memory" ? 100 : 40)) throw new Error("记录数量超过上限。");
        const item = { ...(index < 0 ? {} : items[index]), id: index < 0 ? randomUUID() : items[index].id,
          title: text(request.title, 240), content: text(request.content, request.kind === "memory" ? MAX_MEMORY : MAX_AGENT), updatedAt: Date.now() };
        if (index < 0) items.push(item); else items[index] = item;
        await save(value); return item;
      });
    });
  };
  return { run, directory };
}
