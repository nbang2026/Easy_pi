import { constants } from "node:fs";
import { mkdir, open, rename, lstat, unlink } from "node:fs/promises";
import { agentConfigDirectory } from "./pi-paths.mjs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createSkillLibrary } from "./gui-skills.mjs";
import { MARKET_CATALOG, marketEntry, contentHash, CODING_AGENT } from "./gui-market.mjs";
import { createAgentSources } from "./agent-sources.mjs";
import { classifyTask, rankTaskCandidates } from "./task-routing.mjs";

const MAX_STORE = 10 * 1024 * 1024;
const MAX_AGENT = 256 * 1024;
const MAX_MEMORY = 64 * 1024;
const MAX_AGENTS = 128;
const LOCAL_AGENT_MATCH_SCORE = 7;
const REMOTE_AGENT_MATCH_SCORE = 5;
const LOCAL_SKILL_MATCH_SCORE = 4;
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

export async function fetchAgentDefinition(source, signal, fetcher = globalThis.fetch, expected) {
  const url = agentDownloadUrl(source);
  const timeout = AbortSignal.timeout(12000);
  const response = await fetcher(url, {
    redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: "text/plain", "User-Agent": "Pi-GUI-Agent-Library" },
  });
  if (response.redirected || response.url && response.url !== url.href) { await response.body?.cancel(); throw Error("Agent 下载发生重定向，已停止。"); }
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
  const bytes = Buffer.concat(chunks);
  if (expected && (bytes.length !== expected.bytes || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== expected.blob))
    throw Error("Agent 文件与固定版本目录不一致，请刷新来源。");
  const content = text(new TextDecoder("utf-8", { fatal: true }).decode(bytes), MAX_AGENT);
  if (/^\s*(<!doctype|<html|<script)/i.test(content) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) {
    throw new Error("下载内容不是有效的文本 Agent 定义。");
  }
  return { source: url.href, content };
}

export function createAgentLibrary(options = {}) {
  const directory = options.directory || join(agentConfigDirectory(), "gui-library");
  const filename = join(directory, "library.json");
  let queue = Promise.resolve();
  const marketPreviews = new Map();
  const sources = options.agentSources || createAgentSources({ fetcher: options.fetcher });
  const routingCatalog = options.routingCatalog || MARKET_CATALOG;
  const taskSkillSnapshot = async (id) => skills.taskSkill(id);
  const modelDownloadsAllowed = async () => typeof options.canModelDownload === "function" && await options.canModelDownload() === true;
  const skills = createSkillLibrary({
    directory: options.skillsDirectory || (options.directory ? join(directory, "skills") : undefined),
    fetcher: options.fetcher,
    sources: options.skillSources,
  });
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
        || value.memories.length > 100 || value.agents.length > MAX_AGENTS) throw new Error("记忆库格式无效，原文件未改动。");
      // One damaged record must not hide the rest; it is set aside and written back untouched.
      const ids = new Set();
      const invalid = { memories: [], agents: [] };
      for (const list of ["memories", "agents"]) {
        value[list] = value[list].filter((item) => {
          try {
            if (!item || typeof item.id !== "string" || !/^[a-f0-9-]{36}$/.test(item.id) || ids.has(item.id)
              || !Number.isFinite(item.updatedAt) || (item.source !== undefined && typeof item.source !== "string")) throw new Error();
            if (list === "memories" && (item.scope !== undefined && !["project", "global"].includes(item.scope) ||
              item.scope === "project" && (typeof item.workspace !== "string" || !item.workspace))) throw new Error();
            text(item.title, 240); text(item.content, MAX_AGENT);
            ids.add(item.id); return true;
          } catch { invalid[list].push(item); return false; }
        });
      }
      Object.defineProperty(value, "invalid", { value: invalid, enumerable: false });
      // The active Agent is a user choice; a removed or damaged definition simply leaves none active.
      if (typeof value.settings.activeAgent !== "string" || value.settings.activeAgent !== CODING_AGENT.id && !value.agents.some((item) => item.id === value.settings.activeAgent)) value.settings.activeAgent = "";
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
    if (request?.kind === "skills") {
      if (request.action === "resolve") return (async () => {
        if (authority === "user") throw Error("自动补齐请通过任务授权调用；手动安装请在 Skill 市场预览确认。");
        if (typeof request.query !== "string" || !request.query.trim() || request.query.length > 500) throw Error("请提供 1–500 字的任务说明。");
        const authorized = async () => await modelDownloadsAllowed() && (await load()).settings.autonomousDownloads;
        if (!await authorized()) throw Error("请先在执行控制放行工具权限，并允许自动补齐 Agent 与 Skill。");
        const task = classifyTask(request.query);
        const skill = await skills.autoInstallForTask({ task: { ...task, shouldSearchCatalog: true }, signal, isAuthorized: authorized });
        if (!await authorized()) throw Error("下载权限已撤销，不再加载该 Skill。");
        return skill ? { skill: skill.skill, path: skill.path, content: skill.content, untrusted: true } : { skill: null, message: "未找到可安全安装的匹配 Skill；未执行任何远程脚本。" };
      })();
      return skills.run(request, authority, signal);
    }
    if (request?.kind === "market") {
      if (authority !== "user") return Promise.reject(new Error("市场导入与启用只能由用户在界面操作。"));
      if (request.action === "browse") return sources.browse({ provider: request.provider, query: request.query,
        category: request.category, page: request.page, refresh: request.refresh, signal });
      if (request.action === "list") return enqueue(async () => {
        const value = await load();
        const installed = value.agents.filter((item) => typeof item.marketKey === "string" && item.marketKey).map(({ id, marketKey, title, source, content }) => ({ id, marketKey, title, source, hash: contentHash(content) }));
        const external = value.agents.filter((item) => (typeof item.marketKey === "string" && item.marketKey.startsWith("github:"))).map((item) => ({
          id: "", installedId: item.id, title: item.title, category: "external", description: "Imported GitHub text Agent / 已导入的 GitHub 文本 Agent",
          author: item.marketAuthor || "GitHub source", license: item.marketLicense || "See source", source: item.source, kind: "text-agent", hash: contentHash(item.content), marketKey: item.marketKey, version: item.marketVersion || "",
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
          return { ...item, id: "", installedId: item.id, category: "external", author: item.marketAuthor || "GitHub source", license: item.marketLicense || "See source", kind: "text-agent", hash: contentHash(item.content), version: item.marketVersion || "" };
        }
        const online = request.catalogSource ? await sources.entry(request.catalogSource, request.path, signal) : null;
        const downloaded = await fetchAgentDefinition(online?.source || request.source, signal,
          online ? async () => new Response(await sources.bytes(online, signal)) : options.fetcher, online);
        const now = Date.now();
        for (const [key, value] of marketPreviews) if (value.expires < now) marketPreviews.delete(key);
        if (marketPreviews.size >= 8) marketPreviews.delete(marketPreviews.keys().next().value);
        const token = randomUUID();
        const title = text(online?.title || request.title || decodeURIComponent(new URL(downloaded.source).pathname.split("/").pop()).replace(/\.(md|txt)$/i, ""), 240);
        const entry = { ...downloaded, title, id: "", marketKey: online?.marketKey || `github:${downloaded.source}`, hash: contentHash(downloaded.content), kind: "text-agent",
          author: online?.author || "GitHub source", license: online?.license || "See source", category: online?.category || "external", version: online?.version || "" };
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
        if (value.agents.length + (value.invalid?.agents.length || 0) >= MAX_AGENTS) throw Error("最多保存 128 个 Agent，请先在本地库整理。");
        const item = { id: randomUUID(), title: text(entry.title, 240), content: text(entry.content, MAX_AGENT), source: entry.source, updatedAt: Date.now(), untrusted: true, marketKey: entry.marketKey, importedHash: entry.hash, marketVersion: entry.version || "", marketAuthor: entry.author, marketLicense: entry.license };
        value.agents.push(item); await save(value);
        return { id: item.id, alreadyImported: false };
      }));
      return Promise.reject(new Error("仅支持市场浏览、预览与文本导入。"));
    }
    if (request?.kind === "agent" && request.action === "read" && request.id === CODING_AGENT.id) return Promise.resolve({...CODING_AGENT});
    // Network waits do not block a user's permission changes or local edits.
    if (request?.kind === "agent" && request.action === "download") {
      return (async () => {
        const before = await load();
        if (authority !== "user" && (!before.settings.autonomousDownloads || !await modelDownloadsAllowed())) throw new Error("当前任务未获联网下载授权，或用户已关闭模型自主下载 Agent。");
        const downloaded = await fetchAgentDefinition(request.source, signal, options.fetcher);
        return enqueue(() => locked(async () => {
          const value = await load();
          if (signal?.aborted) throw new Error("Agent 下载已取消。");
          if (authority !== "user" && (!value.settings.autonomousDownloads || !await modelDownloadsAllowed())) throw new Error("下载权限已撤销，文件未保存。");
          if (value.agents.length + (value.invalid?.agents.length || 0) >= MAX_AGENTS) throw new Error("最多保存 128 个 Agent。");
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
        const memories = value.memories.filter(item => !request.workspace || item.scope !== "project" || item.workspace === request.workspace);
        return { ...value, workspace: request.workspace || "", builtinAgents: [{id:CODING_AGENT.id,title:CODING_AGENT.title}], memories: previews(memories), agents: previews(value.agents), ...(skipped ? { skipped } : {}) };
      }
      if (request.kind === "context") {
        // Full recent notes for prompt context; previews would cut every note at 160 characters.
        const value = await load();
        const terms = String(request.query || "").toLowerCase().split(/\s+/).filter(word => word.length > 1).slice(0, 20);
        const relevant = item => terms.reduce((score, word) => score + (`${item.title} ${item.content}`.toLowerCase().includes(word) ? 1 : 0), 0);
        const memories = value.settings.memoryEnabled ? value.memories.filter(item =>
          item.scope !== "project" || item.workspace === request.workspace)
          .sort((a, b) => relevant(b) - relevant(a) || b.updatedAt - a.updatedAt) : [];
        const agent = value.settings.activeAgent === CODING_AGENT.id ? CODING_AGENT : value.agents.find((item) => item.id === value.settings.activeAgent);
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
            if (request.activeAgent && request.activeAgent !== CODING_AGENT.id && !value.agents.some((item) => item.id === request.activeAgent)) throw new Error("记录不存在。");
            value.settings.activeAgent = request.activeAgent;
          }
          await save(value); return value.settings;
        }
        if (request.kind === "memory" && authority !== "user" && !value.settings.memoryEnabled) throw new Error("用户已关闭 Agent 记忆。");
        const items = request.kind === "memory" ? value.memories : value.agents;
        if (request.action === "list") {
          const query = typeof request.query === "string" ? request.query.toLowerCase().slice(0, 200) : "";
          return items.filter((item) => ((!request.workspace && authority === "user") || request.kind !== "memory" || item.scope !== "project" || item.workspace === request.workspace) &&
            `${item.title} ${item.content}`.toLowerCase().includes(query))
            .map(({ id, title, source, updatedAt, scope, workspace }) => ({ id, title, source, updatedAt, scope, workspace }));
        }
        const index = items.findIndex((item) => item.id === request.id);
        if (request.kind === "memory" && index >= 0 && request.workspace &&
          items[index].scope === "project" && items[index].workspace !== request.workspace)
          throw Error("记录属于其他项目，请在原项目中管理。");
        if (request.action === "read") {
          if (index < 0 || authority !== "user" && request.kind === "memory" && items[index].scope === "project" &&
            items[index].workspace !== request.workspace) throw new Error("记录不存在或属于其他项目。"); return items[index];
        }
        if (request.action === "remove") {
          if (authority !== "user") throw new Error("删除库记录需要用户在设置中操作。");
          if (index < 0) throw new Error("记录不存在。");
          items.splice(index, 1);
          if (request.kind === "agent" && value.settings.activeAgent === request.id) value.settings.activeAgent = "";
          await save(value); return { removed: true };
        }
        if (request.action === "move") {
          if (authority !== "user" || request.kind !== "memory" || index < 0 || request.confirmed !== true)
            throw Error("移动记忆需要用户明确确认。");
          const item = items[index];
          if (request.expectedUpdatedAt !== item.updatedAt) throw Error("记忆已变化，请刷新后重试。");
          if (item.scope === "project" && item.workspace !== request.workspace) throw Error("不能从其他项目移动记忆。");
          if (!["project", "global"].includes(request.targetScope) || request.targetScope === "project" && !request.workspace)
            throw Error("无效的目标记忆范围。");
          item.scope = request.targetScope;
          if (item.scope === "project") item.workspace = request.workspace; else delete item.workspace;
          item.updatedAt = Math.max(Date.now(), item.updatedAt + 1);
          await save(value); return item;
        }
        if (request.action !== "save" || (request.id && index < 0)) throw new Error("无效的保存操作。");
        if (request.kind === "agent" && authority !== "user") throw new Error("Agent 定义只能由用户编辑；模型可以下载或读取。");
        if (request.kind === "memory" && index >= 0) {
          if (items[index].scope === "project" && request.workspace && items[index].workspace !== request.workspace)
            throw Error("记忆属于其他项目，普通保存不能改变归属。");
          if (request.scope !== undefined && request.scope !== (items[index].scope || "global"))
            throw Error("普通保存不能改变记忆范围，请明确执行移动操作。");
          if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== items[index].updatedAt) throw Error("记忆已被其他操作修改，请刷新后重试。");
          if (authority !== "user" && request.workspace && (items[index].scope !== "project" || items[index].workspace !== request.workspace))
            throw Error("模型只能更新当前项目的记忆；共享记忆请由用户编辑。");
        }
        if (index < 0 && items.length + (value.invalid?.[request.kind === "memory" ? "memories" : "agents"].length || 0) >= (request.kind === "memory" ? 100 : MAX_AGENTS)) throw new Error("记录数量超过上限。");
        const item = { ...(index < 0 ? {} : items[index]), id: index < 0 ? randomUUID() : items[index].id,
          title: text(request.title, 240), content: text(request.content, request.kind === "memory" ? MAX_MEMORY : MAX_AGENT),
          updatedAt: Math.max(Date.now(), index < 0 ? 0 : items[index].updatedAt + 1) };
        if (request.kind === "memory") {
          const scope = index >= 0 ? items[index].scope || "global"
            : authority === "user" && request.scope ? request.scope : request.workspace ? "project" : "global";
          if (!["project", "global"].includes(scope) || scope === "project" && !request.workspace) throw Error("项目记忆需要有效工作区。");
          item.scope = scope; item.origin = authority;
          if (scope === "project") item.workspace = index >= 0 ? items[index].workspace : request.workspace; else delete item.workspace;
        }
        if (index < 0) items.push(item); else items[index] = item;
        await save(value); return item;
      });
    });
  };
  async function autoDownloadAgent(task, signal, excludeAgentIds = new Set(), isAuthorized = async () => false) {
    const authorized = async () => !signal?.aborted && await isAuthorized() && (await load()).settings.autonomousDownloads;
    if (!task.shouldSearchCatalog || !await authorized()) return null;
    const query = task.searchTerms[0] || "";
    if (!query) return null;
    let failures = 0;
    const pages = await Promise.all(["agency", "voltagent"].map(async (provider) => {
      try { return (await sources.browse({ provider, query, page: 1, signal })).entries; }
      catch (error) { if (signal?.aborted) throw error; failures++; return []; }
    }));
    if (failures === 2) throw Error("Agent catalogs are unavailable; local resources remain available.");
    const candidate = rankTaskCandidates(task, pages.flat(), REMOTE_AGENT_MATCH_SCORE).find(({ candidate: item }) =>
      !excludeAgentIds.has(item?.id) && item?.catalogSource && item?.path && item?.blob && Number.isSafeInteger(item?.bytes))?.candidate;
    if (!candidate || !await authorized()) return null;
    const entry = await sources.entry(candidate.catalogSource, candidate.path, signal);
    if (!await authorized()) return null;
    const downloaded = await fetchAgentDefinition(entry.source, signal, options.fetcher, { blob: entry.blob, bytes: entry.bytes });
    const item = {
      id: randomUUID(), title: text(entry.title, 240), content: downloaded.content,
      source: downloaded.source, updatedAt: Date.now(), untrusted: true,
      marketKey: entry.marketKey, importedHash: contentHash(downloaded.content),
      marketVersion: entry.version || "", marketAuthor: entry.author || "GitHub source",
      marketLicense: entry.license || "See source",
    };
    return enqueue(() => locked(async () => {
      const value = await load();
      if (signal?.aborted || !value.settings.autonomousDownloads || !await isAuthorized()) return null;
      const existing = value.agents.find((agent) => agent.marketKey === item.marketKey);
      if (existing) return existing;
      if (value.agents.length + (value.invalid?.agents.length || 0) >= MAX_AGENTS) return null;
      value.agents.push(item);
      await save(value);
      return item;
    }));
  }
  async function routeTask({ prompt, roleId = "", workspace = "", signal, maxActiveSubagents = 3, allowDownloads = false, isAuthorized = async () => false, excludeAgentIds = [], executionId = "" } = {}) {
    if (typeof prompt !== "string" || Buffer.byteLength(prompt) > 32000) throw Error("Task prompt exceeds the routing limit.");
    if (typeof roleId !== "string" || Buffer.byteLength(roleId) > 128) throw Error("Invalid Agent role ID.");
    if (!Number.isSafeInteger(maxActiveSubagents) || maxActiveSubagents < 1 || maxActiveSubagents > 4) throw Error("Invalid parallel Agent limit.");
    if (typeof allowDownloads !== "boolean") throw Error("Invalid automatic download policy.");
    if (typeof isAuthorized !== "function") throw Error("Invalid automatic download authorization.");
    const authorized = async () => !signal?.aborted && allowDownloads && await isAuthorized() === true;
    if (typeof executionId !== "string" || Buffer.byteLength(executionId) > 160 || /\0/.test(executionId)) {
      throw Error("Invalid Agent execution scope.");
    }
    if (!Array.isArray(excludeAgentIds) || excludeAgentIds.length > MAX_AGENTS + MARKET_CATALOG.length + 1
      || excludeAgentIds.some((id) => typeof id !== "string" || Buffer.byteLength(id) > 128)) {
      throw Error("Invalid excluded Agent roles.");
    }
    const excluded = new Set(excludeAgentIds);
    const task = classifyTask(prompt);
    const warnings = [];
    const value = await load();
    let selectedAgent;
    let manual = false;
    if (roleId) {
      selectedAgent = roleId === CODING_AGENT.id ? CODING_AGENT : value.agents.find((item) => item.id === roleId);
      if (!selectedAgent) throw Error("Selected Agent role does not exist.");
      manual = true;
    } else {
      const candidates = [...value.agents, ...routingCatalog, CODING_AGENT];
      selectedAgent = rankTaskCandidates(task, candidates.filter((item) => !excluded.has(item.id)), LOCAL_AGENT_MATCH_SCORE)[0]?.candidate;
      if (!selectedAgent && task.shouldSearchCatalog && await authorized() && value.settings.autonomousDownloads) {
        try { selectedAgent = await autoDownloadAgent(task, signal, excluded, authorized) || undefined; }
        catch (error) { if (signal?.aborted) throw error; warnings.push("Agent 自动下载未完成，已退回本地资源；请检查网络、下载授权及来源可用性。"); }
      }
      // Keep a general local role as a fallback after trying to find a specialist.
      selectedAgent ||= rankTaskCandidates(task, candidates.filter((item) => !excluded.has(item.id)), 2)[0]?.candidate
        || (!excluded.has(CODING_AGENT.id) ? CODING_AGENT : undefined);
    }
    const availableAgents = [...value.agents, ...routingCatalog, CODING_AGENT];
    if (selectedAgent && !availableAgents.some((item) => item.id === selectedAgent.id)) availableAgents.push(selectedAgent);

    const librarySkills = await skills.run({ action: "list" }, "user", signal);
    const rankedSkills = rankTaskCandidates(task, librarySkills.skills, LOCAL_SKILL_MATCH_SCORE).slice(0, 2);
    const selectedSkills = [];
    for (const { candidate } of rankedSkills) {
      try { selectedSkills.push(await taskSkillSnapshot(candidate.id)); }
      catch (error) { if (signal?.aborted) throw error; }
    }
    if (!selectedSkills.length && task.shouldSearchCatalog && await authorized() && (await load()).settings.autonomousDownloads) {
      try {
        const downloaded = await skills.autoInstallForTask({
          task,
          signal,
          isAuthorized: async () => await authorized() && (await load()).settings.autonomousDownloads,
        });
        if (downloaded) selectedSkills.push(downloaded);
      } catch (error) { if (signal?.aborted) throw error; warnings.push("Skill 自动下载未完成，未加载未验证文件；请检查网络、下载授权及来源可用性。"); }
    }

    const parallelAgents = task.level === "simple" ? 0 : task.level === "moderate" ? 1
      : Math.min(maxActiveSubagents, Math.max(2, task.domains.length || 2));
    const subagents = [];
    const used = new Set(selectedAgent ? [selectedAgent.id] : []);
    for (const domain of task.domains) {
      if (subagents.length >= parallelAgents) break;
      const domainTask = { ...task, domains: [domain] };
      const match = rankTaskCandidates(domainTask, availableAgents, 2)
        .find(({ candidate }) => !used.has(candidate.id))?.candidate;
      if (match) used.add(match.id);
      subagents.push({
        domain,
        title: match?.title || `${domain} specialist`,
        ...(match ? { agentId: match.id, content: match.content, untrusted: !!match.untrusted } : {}),
      });
    }
    if (task.level === "complex") {
      while (subagents.length < parallelAgents) subagents.push({
        domain: "verification",
        title: "Independent verification",
      });
    }
    return {
      executionId: executionId || randomUUID(),
      warnings,
      level: task.level, complexityScore: task.score, domains: task.domains,
      primaryDomain: task.primaryDomain, parallelAgents, shouldSearchCatalog: task.shouldSearchCatalog,
      agent: selectedAgent ? { id: selectedAgent.id, title: selectedAgent.title, content: selectedAgent.content,
        untrusted: !!selectedAgent.untrusted } : null,
      manualAgent: manual,
      skills: selectedSkills.map(({ skill, path, content }) => ({
        id: skill.id, name: skill.name, description: skill.description, path, content,
        source: skill.source, enabled: !!skill.enabled,
      })),
      subagents,
    };
  }
  return {
    run,
    directory,
    enabledSkillPaths: () => skills.enabledPaths(),
    enabledSkillSnapshot: () => skills.enabledSkillSnapshot(),
    routeTask,
    dispose: () => skills.dispose(),
  };
}
