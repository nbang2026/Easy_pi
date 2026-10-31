const providers = Object.freeze({
  agency: { owner: "msitarzewski", repo: "agency-agents", label: "Agency Agents" },
  voltagent: { owner: "VoltAgent", repo: "awesome-claude-code-subagents", label: "VoltAgent" },
});
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const safePath = path => typeof path === "string" && path.length < 1000 && path.split("/").every(part =>
  part && part !== "." && part !== ".." && !/[\\%\x00-\x1f\x7f]/.test(part));
const categories = { engineering: "engineering", design: "design", testing: "engineering", writing: "writing",
  marketing: "business", sales: "business", product: "business", "project-management": "planning",
  support: "operations", "paid-media": "business", strategy: "planning", "game-development": "engineering",
  academic: "analysis", specialized: "productivity", spatial: "design",
  "01-core-development": "engineering", "02-language-specialists": "engineering",
  "03-infrastructure": "operations", "04-quality-security": "engineering", "05-data-ai": "analysis",
  "06-developer-experience": "engineering", "07-specialized-domains": "engineering",
  "08-business-product": "business", "09-meta-orchestration": "planning", "10-research-analysis": "analysis" };

export function createAgentSources({ fetcher = globalThis.fetch } = {}) {
  const cache = new Map(), pending = new Map();
  async function json(url, signal) {
    const timeout = AbortSignal.timeout(12000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response, reader;
    try {
      response = await fetcher(url, { redirect: "error", signal: combined,
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Pi-GUI-Agent-Market" } });
      if (response.redirected || response.url && response.url !== url) throw Error("Agent 目录发生重定向，已停止请求。");
      if (!response.ok) throw Error(response.status === 403 || response.status === 429
        ? "GitHub 请求受限，请稍后重试。" : `Agent 目录请求失败（HTTP ${response.status}）。`);
      if (!response.body || Number(response.headers.get("content-length")) > 4 * 1024 * 1024) throw Error("Agent 目录超过大小限制。");
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) throw Error("Agent 目录超过大小限制。");
        chunks.push(value);
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
      if (reader) await reader.cancel().catch(() => {});
      throw error;
    } finally { reader?.releaseLock(); }
  }
  async function load(provider, refresh, signal) {
    const config = Object.hasOwn(providers, provider) ? providers[provider] : null;
    if (!config) throw Error("未知的 Agent 在线来源。");
    const previous = cache.get(provider);
    if (!refresh && previous?.expires > Date.now()) return previous.entries;
    // Requests with different cancellation owners must not cancel each other.
    if (!signal && pending.has(provider)) return pending.get(provider);
    const task = (async () => {
      const deadline = AbortSignal.timeout(24000);
      const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const base = `https://api.github.com/repos/${config.owner}/${config.repo}`;
      const info = await json(base, requestSignal);
      if (info.private !== false || typeof info.default_branch !== "string" || !info.default_branch) throw Error("Agent 来源不是有效的公开仓库。");
      const commit = await json(`${base}/commits/${encodeURIComponent(info.default_branch)}`, requestSignal);
      if (!sha(commit.sha) || !sha(commit.commit?.tree?.sha)) throw Error("Agent 来源未返回有效的版本信息。");
      const tree = await json(`${base}/git/trees/${commit.commit.tree.sha}?recursive=1`, requestSignal);
      if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 10000) throw Error("Agent 来源目录不完整，请稍后重试。");
      const entries = [], seen = new Set();
      for (const item of tree.tree) {
        const pieces = typeof item.path === "string" ? item.path.split("/") : [];
        const definition = provider === "voltagent" ? pieces[0] === "categories" && pieces.length === 3
          : pieces.length === 2 && !pieces[0].startsWith(".");
        if (!definition || !safePath(item.path) || !/\.md$/i.test(item.path) || /^(README|CONTRIBUTING|CLAUDE|AGENTS|SECURITY)\.md$/i.test(pieces.at(-1))) continue;
        if (item.type !== "blob" || item.mode !== "100644" && item.mode !== "100755" || !sha(item.sha)
          || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 256 * 1024) continue;
        const pathKey = item.path.normalize("NFC").toLowerCase();
        if (seen.has(pathKey)) throw Error("Agent 目录存在重复路径。");
        seen.add(pathKey);
        const group = pieces[provider === "voltagent" ? 1 : 0];
        let name = pieces.at(-1).replace(/\.md$/i, "");
        if (name.startsWith(`${group}-`)) name = name.slice(group.length + 1);
        name = name.replaceAll("-", " ");
        const encoded = item.path.split("/").map(encodeURIComponent).join("/");
        entries.push({ id: "", catalogSource: provider, path: item.path, title: name, category: categories[group] || "productivity",
          description: `${config.label} · ${group}`, author: config.owner, license: info.license?.spdx_id || "See source",
          kind: "text-agent", source: `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${commit.sha}/${encoded}`,
          marketKey: `github:https://raw.githubusercontent.com/${config.owner}/${config.repo}/HEAD/${encoded}`,
          version: commit.sha, hash: "", blob: item.sha, bytes: item.size });
      }
      if (!entries.length) throw Error("此来源没有可用的文本 Agent。");
      entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
      cache.set(provider, { entries, expires: Date.now() + 60000 });
      return entries;
    })();
    if (!signal) pending.set(provider, task);
    try { return await task; } finally { if (pending.get(provider) === task) pending.delete(provider); }
  }
  return {
    async browse({ provider = "agency", query = "", category = "all", page = 1, refresh = false, signal } = {}) {
      if (typeof query !== "string" || query.length > 200 || !Number.isSafeInteger(page) || page < 1 || page > 500
        || typeof category !== "string" || typeof refresh !== "boolean") throw Error("无效的 Agent 目录请求。");
      const entries = await load(provider, refresh, signal);
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const filtered = entries.filter(item => (category === "all" || item.category === category)
        && words.every(word => `${item.title} ${item.path} ${item.author} ${item.description}`.toLowerCase().includes(word)));
      return { entries: filtered.slice((page - 1) * 20, page * 20), total: filtered.length, page, hasMore: page * 20 < filtered.length, provider };
    },
    async entry(provider, path, signal) {
      if (!safePath(path)) throw Error("无效的 Agent 文件路径。");
      const entry = (await load(provider, false, signal)).find(item => item.path === path);
      if (!entry) throw Error("Agent 已不在目录中，请刷新来源。");
      return { ...entry };
    },
    async bytes(entry, signal) {
      const config = Object.hasOwn(providers, entry.catalogSource) ? providers[entry.catalogSource] : null;
      if (!config || !sha(entry.blob)) throw Error("无效的 Agent 下载来源。");
      const data = await json(`https://api.github.com/repos/${config.owner}/${config.repo}/git/blobs/${entry.blob}`, signal);
      if (data.encoding !== "base64" || typeof data.content !== "string" || data.size !== entry.bytes
        || data.content.length > 360000 || !/^[A-Za-z0-9+/=\r\n]*$/.test(data.content)) throw Error("Agent 来源未返回有效的文本文件。");
      return Buffer.from(data.content, "base64");
    },
  };
}
