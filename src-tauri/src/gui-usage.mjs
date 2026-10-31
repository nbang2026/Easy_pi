import { constants } from "node:fs";
import { mkdir, open, lstat, readdir, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { agentConfigDirectory } from "./pi-paths.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fields = ["input", "output", "cacheRead", "cacheWrite"];
const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
export const usageDay = time => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
export function usageRecord(entry, sessionId, task = "") {
  const body = entry.type === "message" ? entry.message : entry;
  if (entry.type === "message" && !["assistant", "toolResult"].includes(body?.role) ||
    !["message", "usage", "compaction", "branch_summary"].includes(entry.type) || !body?.usage) return null;
  const usage = body.usage;
  if (fields.some(key => usage[key] !== undefined && (!Number.isFinite(usage[key]) || usage[key] < 0))) return null;
  const timestamp = body.timestamp ?? entry.timestamp;
  const at = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(at) || at < 0 || at > 8640000000000000) return null;
  const record = {
    version: 1, at, provider: String(body.provider || "unknown").slice(0, 200),
    model: String(body.model || "unknown").slice(0, 200),
    ...Object.fromEntries(fields.map(key => [key, count(usage[key])])),
    cost: Number.isFinite(usage.cost?.total) && usage.cost.total >= 0 ? usage.cost.total : null,
    sessionId: String(sessionId).slice(0, 200),
    taskId: String(typeof task === "object" && task ? at >= task.startedAt ? task.id : "" : task || "").slice(0, 200),
  };
  // Forks preserve entry IDs and timestamps. They must not duplicate a paid call.
  record.key = digest([entry.id || "", entry.type, body.role || "", at, record.provider, record.model,
    ...fields.map(key => record[key]), record.cost]);
  return record;
}
function total(records) {
  const value = { records: records.length, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, knownCost: 0, unknownCost: 0, cacheHit: null };
  for (const row of records) {
    for (const key of fields) value[key] += row[key];
    if (row.cost === null) value.unknownCost++;
    else { value.cost += row.cost; value.knownCost += row.cost; }
  }
  value.tokens = fields.reduce((sum, key) => sum + value[key], 0);
  const prompt = value.input + value.cacheRead + value.cacheWrite;
  value.cacheHit = prompt ? value.cacheRead / prompt : null;
  if (value.unknownCost) value.cost = null;
  return value;
}
export function aggregateUsage(records, filter = {}, now = Date.now()) {
  const today = usageDay(now), month = today.slice(0, 7), last24Hours = now - 86400000;
  const all = records.filter(row => (!filter.provider || row.provider === filter.provider) && (!filter.model || row.model === filter.model));
  const selected = all.filter(row => (!filter.from || usageDay(row.at) >= filter.from) && (!filter.to || usageDay(row.at) <= filter.to));
  const group = key => {
    const groups = new Map();
    for (const row of selected) {
      const name = key(row);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(row);
    }
    return [...groups].map(([name, values]) => ({ name, ...total(values) }));
  };
  const byModel = new Map(), byDay = new Map(), byDayAndModel = new Map();
  for (const row of selected) {
    const id = JSON.stringify([row.provider, row.model]);
    if (!byModel.has(id)) byModel.set(id, []);
    byModel.get(id).push(row);
    const date = usageDay(row.at);
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(row);
    if (!byDayAndModel.has(date)) byDayAndModel.set(date, new Map());
    const models = byDayAndModel.get(date);
    if (!models.has(id)) models.set(id, []);
    models.get(id).push(row);
  }
  const modelBreakdown = [...byModel].map(([id, rows]) => {
    const value = total(rows);
    return { id, provider: rows[0].provider, model: rows[0].model, ...value };
  }).sort((a, b) => b.tokens - a.tokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  const topModels = modelBreakdown.slice(0, 5);
  const includedModels = new Set(topModels.map(model => model.id));
  const days = group(row => usageDay(row.at)).sort((a, b) => a.name.localeCompare(b.name));
  const trend = days.slice(-366).map(date => {
    const dateRows = byDay.get(date.name) || [], buckets = byDayAndModel.get(date.name) || new Map();
    const models = topModels.map(model => ({
      id: model.id, provider: model.provider, model: model.model, ...total(buckets.get(model.id) || []),
    }));
    if (modelBreakdown.length > topModels.length) {
      const other = dateRows.filter(row => !includedModels.has(JSON.stringify([row.provider, row.model])));
      models.push({ id: "__other__", provider: "", model: "其他", ...total(other) });
    }
    return { name: date.name, ...total(dateRows), models };
  });
  return {
    version: 1, checkedAt: now, currency: "USD", source: "Pi recorded usage",
    providers: [...new Set(records.map(row => row.provider))].sort(),
    models: [...new Set(records.filter(row => !filter.provider || row.provider === filter.provider).map(row => row.model))].sort(),
    today: total(all.filter(row => usageDay(row.at) === today)),
    last24Hours: total(all.filter(row => row.at > last24Hours && row.at <= now)),
    month: total(all.filter(row => usageDay(row.at).startsWith(month))),
    all: total(all), selected: total(selected),
    days, modelBreakdown, trend,
    sessions: group(row => row.sessionId).sort((a, b) => b.tokens - a.tokens),
    tasks: group(row => row.taskId || "unassigned").sort((a, b) => b.tokens - a.tokens),
    rows: selected.sort((a, b) => b.at - a.at),
  };
}
export function usageCsv(rows) {
  const names = ["at", "provider", "model", ...fields, "cost", "sessionId", "taskId"];
  const cell = value => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + [names, ...rows.map(row => names.map(key => key === "at" ? new Date(row.at).toISOString() : row[key]))]
    .map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
export function createUsageLog(options = {}) {
  const directory = options.directory || join(agentConfigDirectory(), "gui-usage");
  const source = typeof options.source === "string" && options.source.trim()
    ? options.source.trim().slice(0, 120) : "Pi recorded usage";
  const cached = new Map(), written = new Set();
  let queue = Promise.resolve();
  const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const ensure = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("消耗日志目录无效。");
  };
  const collect = async (entries, sessionId, taskId) => {
    await ensure();
    let added = 0;
    const existing = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (existing.length > 20000) throw Error("消耗日志超过 20000 条，请先导出备份。");
    for (const entry of entries) {
      const row = usageRecord(entry, sessionId, taskId);
      if (!row || written.has(row.key)) continue;
      if (existing.length + added >= 20000 && !existing.includes(`${row.key}.json`)) throw Error("消耗日志已达 20000 条上限，请先导出备份。");
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(row)); await file.sync(); await file.close();
        // Publishing an immutable event is atomic and never replaces another window's event.
        try { await link(temporary, join(directory, `${row.key}.json`)); added++; cached.set(row.key, row); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
      written.add(row.key);
    }
    return { added };
  };
  const load = async () => {
    await ensure();
    const names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (names.length > 20000) throw Error("消耗日志超过 20000 条。");
    const rows = [], warnings = [];
    for (const name of names) {
      const key = name.slice(0, -5);
      try {
      if (!cached.has(key)) {
        const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 8192) throw Error("消耗日志记录无效。");
          const row = JSON.parse(await file.readFile("utf8"));
          if (row.version !== 1 || row.key !== key || !Number.isFinite(row.at) ||
            fields.some(field => !Number.isFinite(row[field]) || row[field] < 0) ||
            row.cost !== null && (!Number.isFinite(row.cost) || row.cost < 0) ||
            ["provider", "model", "sessionId", "taskId"].some(field => typeof row[field] !== "string"))
            throw Error("消耗日志格式无效，原记录已保留。");
          cached.set(key, { version: 1, key, at: row.at, provider: row.provider, model: row.model,
            sessionId: row.sessionId, taskId: row.taskId, cost: row.cost,
            ...Object.fromEntries(fields.map(field => [field, row[field]])) });
        } finally { await file.close(); }
      }
      rows.push(cached.get(key));
      } catch {
        warnings.push({ file: name, reason: "记录无法读取，已保留原文件；统计不包含此项。" });
      }
    }
    return { rows, warnings };
  };
  return {
    record: (entries, sessionId, taskId = "") => serial(() => collect(entries, sessionId, taskId)),
    run: request => serial(async () => {
      const { rows, warnings } = await load();
      const summary = { ...aggregateUsage(rows, request.filter), warnings, incomplete: warnings.length > 0 };
      summary.source = source;
      if (request.action === "export") {
        if (!["csv", "json"].includes(request.format)) throw Error("无效的导出格式。");
        // Only normalized usage fields reach exports; no messages, paths or credentials.
        if (warnings.length && request.format === "csv") throw Error("存在无法读取的日志；请先导出 JSON 查看缺失记录，避免将不完整 CSV 当作完整账本。");
        const content = request.format === "csv" ? usageCsv(summary.rows) : JSON.stringify(summary, null, 2);
        if (Buffer.byteLength(content) > 524288) throw Error("导出超过 512 KiB，请缩小日期或模型筛选范围后分批导出。");
        return { format: request.format, content };
      }
      if (request.action !== "summary") throw Error("未知消耗日志操作。");
      return { ...summary, sessions: summary.sessions.slice(0, 100), tasks: summary.tasks.slice(0, 100),
        modelBreakdown: summary.modelBreakdown.slice(0, 100), rows: summary.rows.slice(0, 500),
        rowsTruncated: summary.rows.length > 500, modelsTruncated: summary.modelBreakdown.length > 100,
        groupsTruncated: summary.sessions.length > 100 || summary.tasks.length > 100 || summary.days.length > 366 };
    }),
  };
}
