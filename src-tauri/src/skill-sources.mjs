import { createHash } from "node:crypto";

const SOURCES = ["skillstore", "skills-sh", "skillsmp"];
const MiB = 1024 * 1024;
const LIMITS = { files: 256, total: 20 * MiB, file: 5 * MiB, skill: 256 * 1024, depth: 12, requests: 320 };
const HOSTS = new Set(["github.com", "raw.githubusercontent.com", "api.github.com", "skillstore.io", "skills.sh", "www.skills.sh", "skillsmp.com"]);
const CATALOG = { pageSize: 20, timeout: 18000, requestTimeout: 8000, cacheTtl: 60000, cacheItems: 60 };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bundleTreeHash = (files) => {
  const modeBound = files.some((file) => file.executable);
  return digest(files.map((file) => `${file.path}\0${file.sha256}${modeBound ? `\0${file.executable ? "100755" : "100644"}` : ""}\n`).join(""));
};
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const cleanText = (value, max = 2000) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max).trim() : "";
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

function segment(value) {
  if (typeof value !== "string" || !value || value === "." || value === ".." || /[\\/<>:"|?*\x00-\x1f\x7f]/.test(value)
    || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
    || /^(conin\$|conout\$)$/i.test(value) || value.toLowerCase() === ".git" || Buffer.byteLength(value) > 255) {
    throw failure("UNSAFE_PATH", "Skill contains an unsafe or unsupported file path.");
  }
  return value;
}
function safePath(value, allowEmpty = false) {
  if (value === "" && allowEmpty) return "";
  if (typeof value !== "string" || value.split("/").length > LIMITS.depth) throw failure("UNSAFE_PATH", "Skill folder exceeds the path depth limit.");
  return value.split("/").map(segment).join("/");
}
function publicUrl(input) {
  if (typeof input !== "string" || input.length > 4096 || !/^https:\/\//i.test(input) || /[\\\x00-\x20\x7f]/.test(input)) {
    throw failure("UNSAFE_URL", "Use a public HTTPS skill or GitHub URL.");
  }
  const authority = input.slice(input.indexOf("//") + 2).split(/[/?#]/, 1)[0];
  if (authority.includes(":") || authority.includes("@")) throw failure("UNSAFE_URL", "URL credentials and ports are not allowed.");
  let url;
  try { url = new URL(input); } catch { throw failure("UNSAFE_URL", "Invalid skill URL."); }
  if (["www.skillstore.io", "www.skills.sh", "www.skillsmp.com", "www.github.com"].includes(url.hostname)) url.hostname = url.hostname.slice(4);
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.username || url.password || url.port || url.search || url.hash) {
    throw failure("UNSAFE_URL", "Unsupported skill URL host or URL parameters.");
  }
  // Inspect the original spelling before URL's dot-segment normalization.
  const rawPath = input.slice(input.indexOf("//") + 2 + authority.length).split(/[?#]/, 1)[0];
  for (const part of rawPath.split("/").filter(Boolean)) {
    let decoded;
    try { decoded = decodeURIComponent(part); } catch { throw failure("UNSAFE_URL", "Invalid URL path encoding."); }
    if (/[\\/%]/.test(decoded) || decoded === "." || decoded === "..") throw failure("UNSAFE_URL", "Encoded separators and traversal are not allowed.");
    segment(decoded);
  }
  return url;
}
const urlParts = (url) => url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
const encodedPath = (path) => path.split("/").map(encodeURIComponent).join("/");
function repository(owner, repo) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(owner || "") || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo || "") || [".", ".."].includes(repo)) {
    throw failure("INVALID_REPOSITORY", "Invalid public GitHub repository.");
  }
  return { owner, repo, repoUrl: `https://github.com/${owner}/${repo}` };
}
function gitLocation(input) {
  const url = publicUrl(input);
  const parts = urlParts(url);
  if (!["github.com", "raw.githubusercontent.com"].includes(url.hostname) || parts.length < 2) throw failure("UNSUPPORTED_SOURCE", "A concrete public GitHub source is required.");
  const base = repository(parts[0], parts[1]);
  if (url.hostname === "raw.githubusercontent.com") {
    if (parts.length < 4) throw failure("INVALID_SOURCE", "Select a GitHub SKILL.md file or skill folder.");
    return { ...base, tail: parts.slice(2), kind: "blob" };
  }
  if (parts.length === 2) return { ...base, tail: [], kind: "repository" };
  if (!["tree", "blob", "raw"].includes(parts[2]) || parts.length < 4) throw failure("INVALID_SOURCE", "Select a GitHub SKILL.md file or skill folder.");
  return { ...base, tail: parts.slice(3), kind: parts[2] === "raw" ? "blob" : parts[2] };
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || failure("ABORTED", "Skill operation cancelled."));
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(signal.reason || failure("ABORTED", "Skill operation cancelled.")); };
    const cleanup = () => signal.removeEventListener("abort", stop);
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
function retryAfter(value) {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(Number(value), 86400);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(86400, Math.ceil((date - Date.now()) / 1000))) : undefined;
}
function payloadError(data) {
  const code = data?.error?.code || data?.code || (typeof data?.error === "string" ? data.error : "");
  if (typeof code === "string" && /^[A-Z_]{3,80}$/.test(code)) return code;
  return "SOURCE_ERROR";
}
const unwrap = (data) => data?.data && !Array.isArray(data.data) ? data.data : data;
const optionalUrl = (value) => { try { return publicUrl(value).href; } catch { return undefined; } };

// Small, inert HTML reader: no DOM, scripts, styles, hydration payloads or remote resources.
// Response bytes, nodes and nesting are bounded independently of source markup.
function htmlEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", trade: "™", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };
  return value.replace(/&(#x[0-9a-f]{1,8}|#\d{1,10}|[a-z]{2,12});/gi, (entity, code) => {
    if (code[0] !== "#") return named[code] ?? entity;
    const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "�";
  });
}
function readHtml(bytes) {
  let html;
  try { html = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw failure("INVALID_HTML", "Skill source returned invalid UTF-8 HTML."); }
  const root = { tag: "root", attrs: {}, children: [] }, stack = [root], elements = [];
  const ignored = new Set(["script", "style", "svg", "template", "iframe", "object", "noscript", "head"]);
  const voids = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const tokens = /<!--[\s\S]*?-->|<![^>]*>|<\/?([A-Za-z][A-Za-z0-9:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
  let previous = 0, skipping, count = 0;
  for (const match of html.matchAll(tokens)) {
    if (++count > 80000) throw failure("INVALID_HTML", "Skill source HTML has too many elements.");
    const tag = match[1]?.toLowerCase(), closing = match[0].startsWith("</");
    if (skipping) {
      if (closing && tag === skipping) skipping = undefined;
      previous = match.index + match[0].length; continue;
    }
    if (match.index > previous) stack.at(-1).children.push(html.slice(previous, match.index));
    previous = match.index + match[0].length;
    if (!tag) continue;
    if (closing) {
      for (let index = stack.length - 1; index > 0; index--) if (stack[index].tag === tag) { stack.length = index; break; }
      continue;
    }
    if (ignored.has(tag)) { skipping = tag; continue; }
    const attrs = {};
    for (const attribute of match[0].slice(tag.length + 1).matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"=<>`]+)))?/g)) {
      const key = attribute[1].toLowerCase();
      if (["href", "rel", "class", "aria-label", "aria-disabled"].includes(key) && attrs[key] === undefined) attrs[key] = htmlEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "").slice(0, 4096);
    }
    const node = { tag, attrs, children: [], parent: stack.at(-1) };
    stack.at(-1).children.push(node); elements.push(node);
    if (!voids.has(tag) && !match[0].endsWith("/>")) {
      if (stack.length >= 64) throw failure("INVALID_HTML", "Skill source HTML is nested too deeply.");
      stack.push(node);
    }
  }
  if (!skipping && previous < html.length) stack.at(-1).children.push(html.slice(previous));
  return elements;
}
function nodeText(node, max = 2000) {
  const parts = [];
  const visit = (value) => {
    if (typeof value === "string") parts.push(htmlEntities(value));
    else { for (const child of value.children) visit(child); if (["p", "div", "br", "h2", "h3", "span", "li"].includes(value.tag)) parts.push(" "); }
  };
  visit(node);
  return cleanText(parts.join("").replace(/\s+/g, " "), max);
}
function descendants(node, predicate) {
  const result = [];
  for (const child of node.children) if (typeof child !== "string") {
    if (predicate(child)) result.push(child);
    result.push(...descendants(child, predicate));
  }
  return result;
}
function catalogLink(href, host) {
  try {
    if (typeof href !== "string" || !href || href.startsWith("//")) return undefined;
    const url = publicUrl(href.startsWith("/") ? `https://${host}${href}` : href);
    return url.hostname === host ? url : undefined;
  } catch { return undefined; }
}
function withRepository(entry) {
  try {
    const location = gitLocation(entry.repoUrl);
    return { ...entry, author: entry.author || location.owner, owner: location.owner, repo: location.repo, repository: `${location.owner}/${location.repo}` };
  } catch { return entry; }
}
function htmlCatalog(bytes, source, page) {
  const host = source === "skills-sh" ? "skills.sh" : "skillsmp.com";
  const elements = readHtml(bytes), entries = [], seen = new Set();
  let hasMore = false, nextUrl;
  for (const anchor of elements.filter((node) => node.tag === "a")) {
    const url = catalogLink(anchor.attrs.href, host);
    if (!url) continue;
    const parts = urlParts(url);
    const nextPath = source === "skillsmp" && url.pathname === `/skills/page/${page + 1}`;
    if (nextPath && anchor.attrs["aria-disabled"] !== "true") { hasMore = true; nextUrl = url.href; }
    if (source === "skills-sh" || parts[0] === "creators") {
      if (parts.length !== (source === "skills-sh" ? 3 : 4)) continue;
      const offset = source === "skills-sh" ? 0 : 1;
      let location;
      try { location = repository(parts[offset], parts[offset + 1]); segment(parts[offset + 2]); }
      catch { continue; }
      const heading = descendants(anchor, (node) => /^h[1-6]$/.test(node.tag))[0];
      const spans = descendants(anchor, (node) => node.tag === "span");
      // skills.sh directory rows have a real heading and repository label. Other
      // three-segment links (topics, docs, external-site entries) are not skills.
      if (source === "skills-sh" && (!heading || !descendants(anchor, (node) => node.tag === "p").some((node) => nodeText(node) === `${location.owner}/${location.repo}`))) continue;
      const name = nodeText(heading || spans[0] || anchor, 240);
      if (!name || seen.has(url.href)) continue;
      const description = source === "skillsmp" ? nodeText(spans[1] || { tag: "span", children: [] }) : "";
      const entry = withRepository({ source, id: parts[offset + 2], ...(source === "skills-sh" ? { skillId: parts[2] } : {}), name, description, author: location.owner, url: url.href, repoUrl: location.repoUrl });
      // Only exact numeric metadata is published; rounded K/M labels are omitted.
      if (source === "skillsmp") {
        let row = anchor.parent;
        while (row && row.tag !== "li") row = row.parent;
        const label = row && nodeText(row).match(/GitHub stars\s*:\s*([\d,]+)(?:\s|$)/);
        if (label && /^\d{1,3}(?:,\d{3})*$|^\d+$/.test(label[1]) && Number.isSafeInteger(Number(label[1].replaceAll(",", "")))) entry.stars = Number(label[1].replaceAll(",", ""));
      } else {
        const last = spans.at(-1), count = last && nodeText(last);
        if (count && /^\d[\d,]*$/.test(count) && Number.isSafeInteger(Number(count.replaceAll(",", "")))) entry.installs = Number(count.replaceAll(",", ""));
      }
      seen.add(url.href);
      if (entries.length >= 1000) throw failure("INVALID_RESPONSE", "Skill source catalog contains too many entries.");
      entries.push(entry);
    }
  }
  if (!entries.length) throw failure("INVALID_RESPONSE", "Skill source HTML does not contain a supported public skill catalog.");
  return { entries, hasMore, ...(nextUrl ? { nextUrl } : {}) };
}

/** Network-only marketplace adapter. Downloaded bytes are untrusted; storage validates SKILL.md. */
export function createSkillSources({ fetcher = globalThis.fetch } = {}) {
  if (typeof fetcher !== "function") throw new TypeError("A fetch implementation is required.");
  let active = 0;
  const waiting = [], catalogCache = new Map();
  function cacheRead(key, refresh) {
    const cached = catalogCache.get(key);
    if (!cached) return undefined;
    if (refresh || cached.expires <= Date.now()) { catalogCache.delete(key); return undefined; }
    catalogCache.delete(key); catalogCache.set(key, cached);
    return structuredClone(cached.value);
  }
  function cacheWrite(key, value) {
    for (const [item, cached] of catalogCache) if (cached.expires <= Date.now()) catalogCache.delete(item);
    catalogCache.delete(key);
    while (catalogCache.size >= CATALOG.cacheItems) catalogCache.delete(catalogCache.keys().next().value);
    catalogCache.set(key, { expires: Date.now() + CATALOG.cacheTtl, value: structuredClone(value) });
    return value;
  }
  const acquire = (signal) => new Promise((resolve, reject) => {
    const item = { start: null, stop: null };
    item.stop = () => { const index = waiting.indexOf(item); if (index >= 0) waiting.splice(index, 1); reject(signal.reason); };
    item.start = () => {
      signal.removeEventListener("abort", item.stop);
      if (signal.aborted) { reject(signal.reason); return; }
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true; active--;
        while (active < 6 && waiting.length) waiting.shift().start();
      });
    };
    if (signal.aborted) reject(signal.reason);
    else if (active < 6) item.start();
    else { waiting.push(item); signal.addEventListener("abort", item.stop, { once: true }); }
  });
  async function operation(signal, work, timeout = 60000) {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    if (combined.aborted) throw combined.reason;
    const timer = setTimeout(() => controller.abort(failure("TIMEOUT", "Skill operation timed out.")), timeout);
    const context = { signal: combined, requests: 0 };
    try { return await work(context); }
    finally { clearTimeout(timer); controller.abort(failure("ABORTED", "Skill operation finished.")); }
  }
  async function request(context, url, options = {}) {
    for (let attempt = 0; ; attempt++) {
      try { return await requestOnce(context, url, options); }
      catch (error) {
        if (attempt || context.signal.aborted || error?.code !== "NETWORK_ERROR") throw error;
      }
    }
  }
  async function requestOnce(context, url, { max = 2 * MiB, json = true, apiKey } = {}) {
    if (++context.requests > LIMITS.requests) throw failure("REQUEST_LIMIT", "Skill source requires too many network requests.");
    const target = new URL(url);
    if (target.protocol !== "https:" || !HOSTS.has(target.hostname) || target.username || target.password || target.port) throw failure("UNSAFE_URL", "Unsupported download host.");
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(failure("TIMEOUT", "Skill source request timed out.")), CATALOG.requestTimeout);
    let release, reader, response;
    try {
      release = await acquire(signal);
      const headers = { Accept: json ? "application/json" : "application/octet-stream", "User-Agent": "Pi-GUI-Skill-Library/1.0.10fix1" };
      if (apiKey && target.origin === "https://skillsmp.com") headers.Authorization = `Bearer ${apiKey}`;
      response = await abortable(Promise.resolve().then(() => fetcher(target.href, { redirect: "error", signal, headers })), signal);
      if (response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== target.href) throw failure("REDIRECT_BLOCKED", "Skill source redirected to an unapproved URL.");
      if (!response.ok) throw failure(response.status === 429 ? "RATE_LIMITED" : `HTTP_${response.status}`, `Skill source returned HTTP ${response.status}.`, { status: response.status, retryAfter: retryAfter(response.headers.get("retry-after")) });
      if (!response.body || Number(response.headers.get("content-length")) > max) throw failure("SIZE_LIMIT", "Skill response is empty or exceeds its size limit.");
      reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        if (!(value instanceof Uint8Array)) throw failure("INVALID_RESPONSE", "Invalid skill response stream.");
        length += value.byteLength;
        if (length > max) throw failure("SIZE_LIMIT", "Skill response exceeds its size limit.");
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (!json) return bytes;
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw failure("INVALID_JSON", "Skill source returned invalid UTF-8 JSON."); }
    } catch (error) {
      controller.abort(error);
      if (reader) void reader.cancel().catch(() => {});
      else if (response?.body) void response.body.cancel().catch(() => {});
      if (context.signal.aborted) throw context.signal.reason;
      if (error?.code || error?.name === "AbortError") throw error;
      throw failure("NETWORK_ERROR", `Cannot connect to ${target.hostname}. Check the network or proxy, then retry.`);
    } finally { reader?.releaseLock(); release?.(); clearTimeout(timer); }
  }
  function github(context, location, suffix, options) {
    return request(context, `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}${suffix ? `/${suffix}` : ""}`, options);
  }
  async function searchOne(context, source, query, page, apiKey) {
    let data, records, hasMore = false;
    const params = new URLSearchParams({ ...(query === undefined ? {} : { q: query }), limit: String(CATALOG.pageSize) });
    if (source !== "skills-sh") params.set("page", String(page));
    if (source === "skillstore") {
      data = await request(context, `https://skillstore.io/api/skills?${params}`);
      records = Array.isArray(data?.data) ? data.data : data?.skills;
    } else if (source === "skills-sh") {
      if (page > 1) return { entries: [], hasMore: false };
      data = await request(context, `https://www.skills.sh/api/search?${params}`);
      records = data?.skills;
    } else {
      data = await request(context, `https://skillsmp.com/api/v1/skills/search?${params}`, { apiKey });
      records = data?.data?.skills;
    }
    if (data?.success === false || data?.error) throw failure(payloadError(data), "Skill source search is unavailable.");
    if (!Array.isArray(records) || records.length > 100) throw failure("INVALID_RESPONSE", "Skill source returned an unsupported search response.");
    if (source !== "skills-sh") {
      const pagination = data?.pagination || data?.data?.pagination || data?.meta || {};
      const total = Number(pagination.total ?? data?.total ?? data?.data?.total);
      const pages = Number(pagination.totalPages ?? pagination.total_pages);
      hasMore = typeof pagination.hasMore === "boolean" ? pagination.hasMore : Number.isFinite(pages) ? page < pages : Number.isFinite(total) ? page * 20 < total : records.length === 20;
    }
    const entries = records.slice(0, CATALOG.pageSize).map((record) => {
      if (!record || typeof record !== "object") return null;
      const id = cleanText(String(record.slug ?? record.skillId ?? record.id ?? ""), 240);
      const name = cleanText(record.displayName || record.name || record.skillId || record.slug, 240);
      if (!id || !name) return null;
      const entry = { source, id, name, description: cleanText(record.description), author: cleanText(record.author?.name || record.author || record.githubUsername, 240) };
      if (source === "skillstore") {
        if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
        entry.url = `https://skillstore.io/skills/${encodeURIComponent(id)}`;
        entry.repoUrl = optionalUrl(record.repo || record.githubUrl || record.repository?.url);
        if (typeof record.ref === "string") entry.ref = cleanText(record.ref, 240);
      } else if (source === "skills-sh") {
        try {
          const [owner, repo, ...rest] = String(record.source || "").split("/");
          if (rest.length) return null;
          const location = repository(owner, repo);
          segment(id);
          entry.repoUrl = location.repoUrl;
          entry.url = `https://skills.sh/${owner}/${repo}/${encodeURIComponent(id)}`;
          entry.skillId = id;
        } catch { return null; }
      } else {
        entry.repoUrl = optionalUrl(record.githubUrl);
        const listed = optionalUrl(record.skillUrl);
        entry.url = listed && new URL(listed).hostname === "skillsmp.com" ? listed : `https://skillsmp.com/skills/${encodeURIComponent(id)}`;
      }
      if (typeof record.license === "string") entry.license = cleanText(record.license, 240);
      if (Number.isSafeInteger(record.installs) && record.installs >= 0) entry.installs = record.installs;
      if (Number.isSafeInteger(record.stars) && record.stars >= 0) entry.stars = record.stars;
      return withRepository(entry);
    }).filter(Boolean);
    return { entries, hasMore };
  }
  async function browseOne(context, source, page, refresh) {
    if (source === "skillstore") return searchOne(context, source, undefined, page);
    // Public pages can contain more than twenty rows. Paginate the observed rows
    // locally before following an actual next link; no rows or endpoints are invented.
    let url = source === "skills-sh" ? "https://www.skills.sh/" : "https://skillsmp.com/skills/page/1";
    let remaining = page;
    for (let sourcePage = 1; sourcePage <= 10000; sourcePage++) {
      const key = JSON.stringify(["html-catalog", source, url]);
      const result = cacheRead(key, refresh) || cacheWrite(key, htmlCatalog(await request(context, url, { json: false, max: 2 * MiB }), source, sourcePage));
      const pages = Math.ceil(result.entries.length / CATALOG.pageSize);
      if (remaining <= pages) {
        const start = (remaining - 1) * CATALOG.pageSize;
        return { entries: result.entries.slice(start, start + CATALOG.pageSize), hasMore: start + CATALOG.pageSize < result.entries.length || Boolean(result.nextUrl) };
      }
      remaining -= pages;
      if (!result.nextUrl) return { entries: [], hasMore: false };
      url = result.nextUrl;
    }
    throw failure("REQUEST_LIMIT", "Skill source pagination exceeds its limit.");
  }
  async function catalog({ source, page, signal, refresh, mode, query, apiKey }) {
    if (![...SOURCES, "all"].includes(source) || !Number.isSafeInteger(page) || page < 1 || page > 10000 || typeof refresh !== "boolean") throw failure("INVALID_REQUEST", "Invalid skill catalog request.");
    return operation(signal, async (context) => {
      const results = await Promise.all((source === "all" ? SOURCES : [source]).map(async (item) => {
        // Cache identity includes a one-way credential digest, never the secret.
        const key = JSON.stringify([mode, item, page, query, item === "skillsmp" && apiKey ? digest(apiKey) : ""]);
        try {
          const cached = cacheRead(key, refresh);
          const result = cached || cacheWrite(key, await (mode === "browse" ? browseOne(context, item, page, refresh) : searchOne(context, item, query, page, apiKey)));
          return { source: item, ok: true, ...result };
        } catch (error) {
          if (context.signal.aborted) throw error;
          return { source: item, ok: false, error: error.message, code: error.code || "SOURCE_ERROR", ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}) };
        }
      }));
      return { entries: results.flatMap((item) => item.entries || []), sources: results.map(({ entries, hasMore, ...status }) => status), page, hasMore: results.some((item) => item.hasMore) };
    }, CATALOG.timeout);
  }
  async function browse({ source = "all", page = 1, signal, refresh = false } = {}) {
    return catalog({ source, page, signal, refresh, mode: "browse" });
  }
  async function search({ source = "all", query = "", page = 1, signal, apiKey, refresh = false } = {}) {
    if (typeof query !== "string" || query.length > 500) throw failure("INVALID_REQUEST", "Invalid skill search request.");
    if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 2048 || /[\x00-\x20\x7f]/.test(apiKey))) throw failure("INVALID_REQUEST", "Invalid SkillsMP API key.");
    return catalog({ source, page, signal, refresh, mode: "search", query: query.trim(), apiKey });
  }
  async function pin(context, location) {
    if (location.ref !== undefined) {
      const result = await github(context, location, `commits/${encodeURIComponent(location.ref)}`, { max: 2 * MiB });
      if (!sha(result?.sha)) throw failure("INVALID_COMMIT", "GitHub did not return a full commit SHA.");
      if (sha(location.ref) && result.sha !== location.ref) throw failure("INVALID_COMMIT", "GitHub returned a different pinned commit.");
      return { ...location, commit: result.sha, tree: result.commit?.tree?.sha };
    }
    if (!location.tail.length) {
      const info = await github(context, location, "", { max: MiB });
      if (info?.private || typeof info?.default_branch !== "string") throw failure("INVALID_REPOSITORY", "A public GitHub repository is required.");
      return pin(context, { ...location, ref: info.default_branch });
    }
    // GitHub URLs do not delimit slash-containing refs. Test every bounded split;
    // accepting only one result avoids silently selecting the wrong branch/folder.
    if (location.tail.length > LIMITS.depth * 2 + 1) throw failure("UNSAFE_PATH", "GitHub URL is too deep.");
    const candidates = [];
    const max = location.kind === "blob" ? location.tail.length - 1 : location.tail.length;
    for (let count = 1; count <= max; count++) {
      const ref = location.tail.slice(0, count).join("/");
      const path = location.tail.slice(count).join("/");
      if (sha(location.tail[0]) && count > 1) break;
      try {
        const pinned = await pin(context, { ...location, ref, path });
        candidates.push(pinned);
      } catch (error) { if (error.status !== 404 && error.status !== 422) throw error; }
    }
    if (candidates.length !== 1) throw failure(candidates.length ? "AMBIGUOUS_REF" : "SOURCE_NOT_FOUND", candidates.length ? "GitHub URL matches multiple refs. Select an explicit commit URL." : "GitHub source was not found.", { candidates: candidates.map(({ commit, path, ref }) => ({ commit, path, ref })) });
    return candidates[0];
  }
  async function treeAt(context, location, treeSha) {
    if (!sha(treeSha)) throw failure("INVALID_TREE", "GitHub did not return a valid tree SHA.");
    const result = await github(context, location, `git/trees/${treeSha}?recursive=1`, { max: 8 * MiB });
    if (result?.truncated || !Array.isArray(result?.tree) || result.tree.length > 50000) throw failure("TRUNCATED_TREE", "GitHub tree is incomplete or too large; select a concrete skill folder.");
    return result.tree;
  }
  async function selectFolder(context, location, skillId) {
    if (location.path !== undefined) {
      let folder = location.path;
      if (location.kind === "blob") {
        if (!folder.endsWith("/SKILL.md") && folder !== "SKILL.md") throw failure("INVALID_SOURCE", "Select SKILL.md or the skill's folder.");
        folder = folder === "SKILL.md" ? "" : folder.slice(0, -9);
      }
      safePath(folder, true);
      // Traverse tree entries by exact name; symlink/submodule ancestors cannot be followed.
      let root = location.tree;
      for (const part of folder ? folder.split("/") : []) {
        const result = await github(context, location, `git/trees/${root}`, { max: 8 * MiB });
        if (result?.truncated || !Array.isArray(result?.tree)) throw failure("TRUNCATED_TREE", "GitHub tree is incomplete.");
        const entry = result.tree.find((item) => item.path === part);
        if (!entry || entry.type !== "tree" || entry.mode !== "040000" || !sha(entry.sha)) throw failure("UNSAFE_PATH", "Skill folder is missing or traverses a symlink/submodule.");
        root = entry.sha;
      }
      return { folder, tree: await treeAt(context, location, root) };
    }
    const tree = await treeAt(context, location, location.tree);
    const candidates = tree.filter((item) => item.type === "blob" && (item.path === "SKILL.md" || item.path.endsWith("/SKILL.md"))).map((item) => item.path === "SKILL.md" ? "" : item.path.slice(0, -9));
    const desired = cleanText(skillId, 240).normalize("NFC").toLowerCase();
    let matching = desired ? candidates.filter((path) => path.split("/").pop()?.normalize("NFC").toLowerCase() === desired) : candidates;
    // Repository-root SKILL.md is an unambiguous single-skill repository.
    if (!matching.length && candidates.length === 1 && candidates[0] === "") matching = [""];
    if (matching.length !== 1) throw failure(matching.length ? "AMBIGUOUS_SKILL" : "SKILL_NOT_FOUND", `${matching.length ? "Multiple matching skill folders." : "No matching SKILL.md folder was found."} Paste a concrete GitHub folder URL. Candidate paths: ${(matching.length ? matching : candidates).slice(0, 5).map((path) => cleanText(path || "(repository root)", 100)).join(", ") || "none"}.`, { candidates: (matching.length ? matching : candidates).slice(0, 100).map((path) => ({ path, url: `${location.repoUrl}/tree/${location.commit}${path ? `/${encodedPath(path)}` : ""}` })) });
    const folder = safePath(matching[0], true);
    const prefix = folder ? `${folder}/` : "";
    return { folder, tree: tree.filter((item) => !prefix || item.path.startsWith(prefix)).map((item) => ({ ...item, path: item.path.slice(prefix.length) })) };
  }
  async function resolveBundle({ source, url, entry, signal, onProgress, latest = false } = {}) {
    source ||= entry?.source || "all";
    const requested = publicUrl(url || entry?.url || entry?.repoUrl);
    if (source === "all") source = ({ "skillstore.io": "skillstore", "skills.sh": "skills-sh", "skillsmp.com": "skillsmp", "github.com": "github", "raw.githubusercontent.com": "github" })[requested.hostname];
    if (![...SOURCES, "github"].includes(source)) throw failure("INVALID_REQUEST", "Unknown skill source.");
    return operation(signal, async (context) => {
      let location, skillId, metadata = {}, rawManifest;
      const warnings = ["Downloaded skill content is untrusted and has not been executed. License and marketplace metadata are not independently verified."];
      const parts = urlParts(requested);
      if (["github.com", "raw.githubusercontent.com"].includes(requested.hostname)) {
        location = gitLocation(requested.href);
        if (location.kind === "repository") throw failure("INVALID_SOURCE", "Select a concrete GitHub skill folder or SKILL.md file.");
        if (latest) {
          if (!entry || entry.owner?.toLowerCase() !== location.owner.toLowerCase() || entry.repo?.toLowerCase() !== location.repo.toLowerCase() || typeof entry.path !== "string") throw failure("INVALID_REQUEST", "Updating a GitHub skill requires its installed canonical identity.");
          const folder = safePath(entry.path, true);
          const expected = location.tail.slice(1).join("/");
          const originalFolder = location.kind === "blob" ? expected === "SKILL.md" ? "" : expected.endsWith("/SKILL.md") ? expected.slice(0, -9) : null : expected;
          if (!sha(location.tail[0]) || originalFolder !== folder) throw failure("INVALID_REQUEST", "Update URL does not match the installed pinned skill folder.");
          location = { ...repository(location.owner, location.repo), tail: [], kind: "tree", path: folder };
        }
      } else if (source === "skillstore" && requested.hostname === "skillstore.io") {
        if (parts.length !== 2 || parts[0] !== "skills" || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw failure("INVALID_SOURCE", "Select a Skillstore skill page.");
        const detail = unwrap(await request(context, `https://skillstore.io/api/skills/${encodeURIComponent(parts[1])}`));
        metadata = detail?.skill || detail;
        if (!metadata || typeof metadata !== "object") throw failure("INVALID_RESPONSE", "Skillstore returned invalid skill metadata.");
        try { rawManifest = await request(context, `https://skillstore.io/api/skills/${encodeURIComponent(parts[1])}/manifest`); }
        catch (error) { if (error.status !== 404) throw error; warnings.push("Skillstore manifest is unavailable; source was resolved through GitHub metadata."); }
        const manifest = unwrap(rawManifest);
        const sourceMeta = manifest?.source && typeof manifest.source === "object" ? manifest.source : {};
        const repoUrl = metadata.repo || metadata.githubUrl || metadata.github_url || metadata.repository?.url || sourceMeta.repo || sourceMeta.url || manifest?.repo || manifest?.repository?.url;
        location = gitLocation(repoUrl);
        if (location.kind === "repository") {
          const path = sourceMeta.path ?? manifest?.path ?? metadata.path ?? metadata.skillPath;
          if (typeof path !== "string") throw failure("INVALID_SOURCE", "Skillstore metadata does not identify an exact source folder.");
          location.path = path === "SKILL.md" ? "" : path.endsWith("/SKILL.md") ? path.slice(0, -9) : path;
          location.ref = sourceMeta.commit || sourceMeta.ref || manifest?.commit || manifest?.ref || metadata.ref;
          if (typeof location.ref !== "string" || !location.ref) throw failure("INVALID_SOURCE", "Skillstore metadata does not identify a source revision.");
        }
        // A revision embedded in the source URL takes precedence over unrelated metadata refs.
        warnings.push("Skillstore manifest/signature was retained as metadata; no cryptographic signature verification is claimed.");
      } else if (source === "skills-sh" && requested.hostname === "skills.sh") {
        if (parts.length !== 3) throw failure("INVALID_SOURCE", "Select a skills.sh owner/repository/skill page.");
        location = { ...repository(parts[0], parts[1]), tail: [], kind: "repository" };
        skillId = parts[2];
      } else if (source === "skillsmp" && requested.hostname === "skillsmp.com") {
        if (!(parts.length === 2 && parts[0] === "skills" || parts.length === 4 && parts[0] === "creators")) throw failure("INVALID_SOURCE", "Select a SkillsMP skill page or concrete GitHub URL.");
        if (parts[0] === "creators") {
          // A creator slug encodes a path, not the SKILL.md name. Re-read the exact
          // public detail page and require its concrete, matching GitHub folder.
          const expected = repository(parts[1], parts[2]);
          const elements = readHtml(await request(context, requested.href, { json: false, max: 2 * MiB }));
          const candidates = new Map();
          for (const anchor of elements.filter((node) => node.tag === "a")) {
            try {
              const target = publicUrl(anchor.attrs.href);
              if (target.hostname !== "github.com") continue;
              const candidate = gitLocation(target.href);
              if (candidate.owner.toLowerCase() !== expected.owner.toLowerCase() || candidate.repo.toLowerCase() !== expected.repo.toLowerCase() || candidate.kind === "repository") continue;
              if (candidate.kind === "blob" && candidate.tail.at(-1) !== "SKILL.md") continue;
              candidates.set(target.href, candidate);
            } catch { /* Unrelated/unsafe outbound links are inert and ignored. */ }
          }
          if (candidates.size !== 1) throw failure("SOURCE_NOT_FOUND", "SkillsMP detail page does not uniquely identify a matching GitHub skill folder.");
          location = candidates.values().next().value;
          metadata = { name: cleanText(entry?.name, 240), description: cleanText(entry?.description) };
        } else {
          // Legacy API search results are reverified by exact URL/id; no guessed mapping.
          const slug = parts.at(-1);
          const result = await searchOne(context, "skillsmp", cleanText(entry?.name || slug, 240), 1);
          const matches = result.entries.filter((item) => item.url === requested.href || item.id === String(entry?.id || slug));
          if (matches.length !== 1 || !matches[0].repoUrl) throw failure("SOURCE_NOT_FOUND", "SkillsMP source could not be uniquely verified. Select the skill's concrete GitHub URL.");
          metadata = matches[0];
          location = gitLocation(matches[0].repoUrl);
          if (location.kind === "repository") throw failure("INVALID_SOURCE", "SkillsMP lists no concrete skill folder. Select its GitHub SKILL.md URL.");
        }
      } else throw failure("INVALID_SOURCE", "Skill URL does not match the selected marketplace.");
      const pinned = await pin(context, location);
      if (!sha(pinned.tree)) throw failure("INVALID_TREE", "GitHub commit does not contain a valid tree.");
      const selected = await selectFolder(context, pinned, skillId);
      const paths = new Map();
      const blobs = [];
      let declared = 0;
      for (const item of selected.tree) {
        const path = safePath(item.path);
        const key = path.normalize("NFC").toLowerCase();
        if (paths.has(key)) throw failure("PATH_COLLISION", "Skill contains colliding file or directory names.");
        paths.set(key, path);
        if (item.type === "tree" && item.mode === "040000") continue;
        if (item.type !== "blob" || !["100644", "100755"].includes(item.mode)) throw failure("UNSAFE_FILE", "Skill contains a symlink, submodule, or unsupported file.");
        if (!sha(item.sha) || !Number.isSafeInteger(item.size) || item.size < 0) throw failure("INVALID_TREE", "GitHub file metadata is invalid.");
        if (item.size > (path === "SKILL.md" ? LIMITS.skill : LIMITS.file)) throw failure("SIZE_LIMIT", "Skill file exceeds the size limit.");
        declared += item.size; blobs.push(item);
        if (blobs.length > LIMITS.files || declared > LIMITS.total) throw failure("SIZE_LIMIT", "Skill bundle exceeds 256 files or 20 MiB.");
      }
      if (!blobs.some((item) => item.path === "SKILL.md")) throw failure("SKILL_NOT_FOUND", "Selected folder does not contain SKILL.md.");
      // A file cannot also be an implicit directory, including case/Unicode variants.
      const blobKeys = new Set(blobs.map((item) => item.path.normalize("NFC").toLowerCase()));
      for (const item of blobs) {
        const pieces = item.path.normalize("NFC").toLowerCase().split("/");
        for (let count = 1; count < pieces.length; count++) if (blobKeys.has(pieces.slice(0, count).join("/"))) throw failure("PATH_COLLISION", "Skill file conflicts with a directory.");
      }
      let totalBytes = 0, completed = 0, next = 0;
      const files = [];
      const notify = () => { if (typeof onProgress === "function") onProgress({ phase: "download", completed, total: blobs.length, totalBytes }); };
      notify();
      await Promise.all(Array.from({ length: Math.min(6, blobs.length) }, async () => {
        while (next < blobs.length) {
          const item = blobs[next++];
          const fullPath = selected.folder ? `${selected.folder}/${item.path}` : item.path;
          const bytes = await request(context, `https://raw.githubusercontent.com/${encodeURIComponent(pinned.owner)}/${encodeURIComponent(pinned.repo)}/${pinned.commit}/${encodedPath(fullPath)}`, { json: false, max: item.path === "SKILL.md" ? LIMITS.skill : LIMITS.file });
          if (bytes.byteLength !== item.size) throw failure("SIZE_MISMATCH", "Downloaded file size differs from its pinned Git tree.");
          const gitSha = createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
          if (gitSha !== item.sha) throw failure("HASH_MISMATCH", "Downloaded file does not match its pinned Git blob.");
          totalBytes += bytes.byteLength;
          if (totalBytes > LIMITS.total) throw failure("SIZE_LIMIT", "Skill bundle exceeds 20 MiB.");
          files.push({ path: item.path, bytes, sha256: digest(bytes), executable: item.mode === "100755" }); completed++; notify();
        }
      }));
      files.sort((a, b) => compare(a.path, b.path));
      const treeHash = bundleTreeHash(files);
      const canonical = `${pinned.repoUrl}/tree/${pinned.commit}${selected.folder ? `/${encodedPath(selected.folder)}` : ""}`;
      const result = { source, url: requested.hostname === "github.com" || requested.hostname === "raw.githubusercontent.com" ? canonical : requested.href, repoUrl: pinned.repoUrl, owner: pinned.owner, repo: pinned.repo, commit: pinned.commit, path: selected.folder, files, treeHash, totalBytes, warnings };
      for (const key of ["name", "description", "license"]) {
        const value = cleanText(metadata[key] || (key === "name" ? metadata.displayName : ""), key === "description" ? 2000 : 240);
        if (value) result[key] = value;
      }
      if (rawManifest !== undefined) result.rawManifest = rawManifest;
      return result;
    });
  }
  return { browse, search, resolveBundle };
}
