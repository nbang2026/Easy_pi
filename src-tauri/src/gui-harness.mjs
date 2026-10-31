import { constants } from "node:fs";
import { mkdir, lstat, open, rename, unlink, readdir, realpath } from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { agentConfigDirectory } from "./pi-paths.mjs";
import { isProtectedWorkspacePath, redactWorkspaceText } from "./task-scheduler.mjs";

export const HARNESS_DEFAULTS = Object.freeze({
  mode: "project", maxMinutes: 0, maxTurns: 0, maxToolCalls: 0,
  maxTokens: 0, maxCost: 0, maxRepeatedFailures: 3,
});
// Zero disables a quota; explicit limits remain available per project.
const ranges = { maxMinutes: [0, 1440], maxTurns: [0, 10000], maxToolCalls: [0, 10000],
  maxTokens: [0, 100000000], maxCost: [0, 10000], maxRepeatedFailures: [0, 20] };
const modes = ["readonly", "confirm", "project", "autonomous"];
async function lockSettings(path) {
  const same = (a, b) => a?.ino === b?.ino && a?.dev === b?.dev;
  for (let attempt = 0; attempt < 4; attempt++) {
    let handle, owned;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      owned = await handle.stat();
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return async () => {
        await handle.close();
        if (same(owned, await lstat(path).catch(() => null))) await unlink(path).catch(() => {});
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        if (same(owned, await lstat(path).catch(() => null))) await unlink(path).catch(() => {});
        throw error;
      }
      if (error.code !== "EEXIST") throw error;
      try {
        const observed = await lstat(path);
        if (!observed.isFile() || observed.isSymbolicLink() || observed.size > 512) throw Error("配置锁异常，请检查后重试。");
        const reader = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes;
        try {
          if (!same(observed, await reader.stat())) continue;
          bytes = await reader.readFile("utf8");
        } finally { await reader.close(); }
        let stale = !bytes.length && Date.now() - observed.mtimeMs > 5000;
        if (bytes.length) {
          let owner;
          try { owner = JSON.parse(bytes); } catch { throw Error("配置锁异常，请检查后重试。"); }
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw Error("配置锁异常，请检查后重试。");
          try { process.kill(owner.pid, 0); }
          catch (failure) { if (failure.code === "ESRCH") stale = true; else if (failure.code !== "EPERM") throw failure; }
        }
        if (!stale) throw Error("其他窗口正在保存配置，请稍后刷新重试。");
        if (same(observed, await lstat(path))) await unlink(path);
      } catch (failure) { if (failure.code !== "ENOENT") throw failure; }
    }
  }
  throw Error("其他窗口正在保存配置，请稍后刷新重试。");
}
const active = run => run?.state === "running";
const hash = value => createHash("sha256").update(value).digest("hex");
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};
export function harnessSettings(value) {
  if (!value || !modes.includes(value.mode)) throw Error("无效的执行权限模式。");
  const result = { mode: value.mode };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < min || value[key] > max ||
      key !== "maxCost" && !Number.isInteger(value[key])) throw Error(`无效的任务限制：${key}`);
    result[key] = value[key];
  }
  return result;
}
async function canonical(target) {
  try { return await realpath(target); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(target);
    if (parent === target) throw error;
    return resolve(await canonical(parent), relative(parent, target));
  }
}
export async function harnessToolAllowed(mode, event, workspace) {
  if (mode === "autonomous") return true;
  if (event.toolName === "gui_workbench") return true;
  if (event.toolName === "gui_harness") return ["status", "checkpoint"].includes(event.input?.action);
  if (event.toolName === "gui_delegate") return true;
  if (event.toolName === "gui_skills") return ["list", "read"].includes(event.input?.action);
  if (["gui_memory", "gui_agent_library"].includes(event.toolName)) return ["list", "read"].includes(event.input?.action);
  const readTools = ["read", "workspace_read", "workspace_search", "workspace_list"];
  if (![...readTools, ...(mode === "project" ? ["write", "edit"] : [])].includes(event.toolName)) return false;
  const supplied = event.input?.path;
  if (supplied !== undefined && (typeof supplied !== "string" || supplied.includes("\0"))) return false;
  if (["read", "write", "edit"].includes(event.toolName) && !supplied) return false;
  const root = await realpath(workspace);
  if (isProtectedWorkspacePath(relative(root, resolve(root, supplied || ".")))) return false;
  let target;
  try {
    target = ["write"].includes(event.toolName) ? await canonical(resolve(root, supplied || "."))
      : await realpath(resolve(root, supplied || "."));
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const within = relative(root, target);
  if (isAbsolute(within) || within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return false;
  if (isProtectedWorkspacePath(within)) return false;
  if (["read", "workspace_read", "write", "edit"].includes(event.toolName)) {
    try { if ((await lstat(target)).nlink > 1) return false; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // Pi expands ~/@ and read-path variants. Send the checked absolute path so
  // execution cannot reinterpret a relative path against different defaults.
  event.input.path = target;
  return true;
}

// One controller owns one run file. Other windows' runs are never resumed or
// rewritten automatically; a stored in-flight call always needs reconciliation.
export function createHarness(options = {}) {
  const directory = options.directory || join(agentConfigDirectory(), "gui-harness");
  const now = options.now || Date.now;
  let workspace = "", sessionId = "", settings = { ...HARNESS_DEFAULTS }, current;
  let queue = Promise.resolve(), disposed = false, ready = false;
  let approvalController = new AbortController();
  const pending = new Map(), seenMessages = new Set(), seenCalls = new Set();
  const outputPath = async value => {
    if (typeof value !== "string" || !value || value.length > 4096 || /[\0\r\n]/.test(value)) return;
    const path = relative(workspace, resolve(workspace, value));
    if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..") || isProtectedWorkspacePath(path)) return;
    try {
      const actual = relative(workspace, await realpath(resolve(workspace, path)));
      const info = await lstat(resolve(workspace, path));
      if (!actual || isAbsolute(actual) || actual.split(/[\\/]/).includes("..") || isProtectedWorkspacePath(actual)
        || !info.isFile() || info.isSymbolicLink() || info.nlink > 1) return;
      return path;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  let lastFailure = "", consecutiveFailures = 0;
  const serial = fn => {
    const operation = queue.then(fn);
    queue = operation.catch(() => {});
    return operation;
  };
  const ensure = async () => {
    for (const folder of [directory, join(directory, "runs"), join(directory, "settings")]) {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const stat = await lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("任务记录目录无效。");
    }
  };
  const read = async file => {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 524288) throw Error("任务记录格式或大小无效。");
      return JSON.parse(await handle.readFile("utf8"));
    } finally { await handle.close(); }
  };
  const write = async (file, value) => {
    await ensure();
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 524288) throw Error("任务记录超过上限。");
    const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await rename(temporary, file);
    } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  };
  const snapshot = () => current ? structuredClone(current) : null;
  const settingsFile = () => join(directory, "settings", `${hash(workspace)}.json`);
  const revision = () => hash(JSON.stringify(stable(settings)));
  const reloadSettings = async () => {
    try { settings = harnessSettings(await read(settingsFile())); }
    catch (error) { if (error.code !== "ENOENT") throw error; settings = { ...HARNESS_DEFAULTS }; }
  };
  const persist = async () => {
    if (!current) return;
    current.updatedAt = now();
    current.pending = [...pending.values()];
    try { await write(join(directory, "runs", `${current.id}.json`), current); }
    catch (error) {
      current.state = "interrupted"; current.reason = "persistence"; ready = false;
      throw error;
    }
  };
  const event = (type, extra = {}) => {
    current.events.push({ at: now(), type, ...extra });
    if (current.events.length > 200) current.events.shift();
  };
  const limitReason = () => {
    if (!active(current)) return current?.state === "limited" ? current.reason : "";
    const limits = current.limits, usage = current.usage;
    if (limits.maxMinutes > 0 && now() - current.startedAt >= limits.maxMinutes * 60000) return "time";
    if (limits.maxTokens > 0 && usage.tokens >= limits.maxTokens) return "tokens";
    if (limits.maxCost > 0 && usage.cost >= limits.maxCost) return "cost";
    return "";
  };
  const limit = async reason => {
    if (!active(current)) return;
    approvalController.abort();
    current.state = "limited"; current.reason = reason;
    event("limit", { reason }); await persist();
  };
  const check = async () => {
    const reason = limitReason();
    if (reason) await limit(reason);
    return reason;
  };
  return {
    snapshot,
    async attach(cwd, session) {
      approvalController.abort();
      return serial(async () => {
        ready = false;
        if (active(current)) {
          current.state = "interrupted"; event("interrupted"); await persist();
        }
        workspace = await realpath(cwd);
        sessionId = String(session || "");
        current = undefined; pending.clear(); seenMessages.clear(); seenCalls.clear();
        settings = { ...HARNESS_DEFAULTS };
        await ensure();
        await reloadSettings();
        ready = true;
      });
    },
    start() {
      return serial(async () => {
        if (disposed || !workspace || !ready) throw Error("任务控制器尚未就绪，或配置损坏。");
        if (active(current)) return snapshot();
        await reloadSettings();
        pending.clear(); seenMessages.clear(); seenCalls.clear();
        lastFailure = ""; consecutiveFailures = 0;
        approvalController = new AbortController();
        current = { version: 1, id: randomUUID(), workspace, sessionId, state: "running",
          startedAt: now(), updatedAt: now(), limits: { ...settings },
          usage: { turns: 0, toolCalls: 0, tokens: 0, cost: 0, costKnown: true },
          pending: [], events: [], plan: [], artifacts: [], verification: null };
        event("start");
        try { await persist(); }
        catch (error) {
          current.state = "interrupted";
          current.reason = "persistence";
          ready = false;
          throw error;
        }
        return snapshot();
      });
    },
    beforeTurn() {
      return serial(async () => {
        if (!active(current)) return current?.reason || "inactive";
        if (await check()) return current.reason;
        if (current.limits.maxTurns > 0 && current.usage.turns >= current.limits.maxTurns) { await limit("turns"); return "turns"; }
        current.usage.turns++; event("turn"); await persist();
        return "";
      });
    },
    beforeSubagentTurn() {
      return serial(async () => {
        if (!active(current)) return current?.reason || "inactive";
        if (await check()) return current.reason;
        if (current.limits.maxTurns > 0 && current.usage.turns >= current.limits.maxTurns) {
          await limit("turns");
          return "turns";
        }
        current.usage.turns++;
        event("subagent_turn");
        await persist();
        return "";
      });
    },
    async beforeTool(call) {
      const prepared = await serial(async () => {
        if (!call || typeof call.toolCallId !== "string" || !call.toolCallId.trim() || call.toolCallId.length > 256 ||
          typeof call.toolName !== "string" || !call.toolName.trim() || call.toolName.length > 200 ||
          !call.input || typeof call.input !== "object" || Array.isArray(call.input))
          return { block: true, terminate: true, reason: "无效的工具调用。" };
        if (!active(current)) return { block: true, terminate: true, reason: "任务已停止或未建立执行记录。" };
        if (await check()) return { block: true, terminate: true, reason: `任务达到限制：${current.reason}` };
        if (current.limits.maxToolCalls > 0 && current.usage.toolCalls >= current.limits.maxToolCalls) {
          await limit("toolCalls"); return { block: true, terminate: true, reason: "任务已达到工具调用上限。" };
        }
        current.usage.toolCalls++;
        if (seenCalls.has(call.toolCallId)) {
          await limit("duplicateCall"); return { block: true, terminate: true, reason: "拒绝重复执行相同调用 ID。" };
        }
        seenCalls.add(call.toolCallId);
        const original = JSON.stringify(stable(call));
        const checked = structuredClone(call);
        const mode = current.limits.mode;
        const allowed = await harnessToolAllowed(mode === "confirm" ? "project" : mode, checked, workspace);
        const shell = ["project", "confirm"].includes(mode) && call.toolName === "bash" &&
          typeof call.input.command === "string" && !!call.input.command.trim() && call.input.command.length <= 8192 && JSON.stringify(call.input).length <= 30000;
        const ask = shell || allowed && mode === "confirm" && ["write", "edit"].includes(call.toolName);
        if ((!allowed && !shell) || ask && typeof options.requestApproval !== "function") {
          event("blocked", { tool: call.toolName });
          await persist();
          return { block: true, reason: "当前权限模式不允许此工具或路径。搜索和列目录请用 workspace_search、workspace_list，读取用 read 或 workspace_read；这些工具会保护凭据和私密配置。不得绕过限制。" };
        }
        if (ask) { event("approval_requested", { tool: call.toolName }); await persist(); }
        return { checked, original, ask, runId: current.id, sessionId, signal: approvalController.signal };
      });
      if (!prepared.checked) return prepared;
      let approved = !prepared.ask;
      if (prepared.ask && !prepared.signal.aborted) {
        try { approved = await options.requestApproval({ ...prepared.checked, runId: prepared.runId,
          sessionId: prepared.sessionId, signal: prepared.signal }) === true; }
        catch { approved = false; }
      }
      return serial(async () => {
        if (disposed || !active(current) || current.id !== prepared.runId || prepared.signal.aborted || await check())
          return { block: true, terminate: true, reason: "任务已停止或审批已失效。" };
        if (!approved || JSON.stringify(stable(call)) !== prepared.original) {
          event("blocked", { tool: call.toolName }); await persist();
          return { block: true, reason: "用户拒绝、审批超时或调用已变化；操作未执行。" };
        }
        // Revalidate filesystem boundaries after the user has had time to review.
        if (prepared.checked.toolName !== "bash" && !await harnessToolAllowed(current.limits.mode === "confirm" ? "project" : current.limits.mode, prepared.checked, workspace))
          return { block: true, reason: "审批期间路径发生变化，操作未执行。" };
        Object.assign(call.input, prepared.checked.input);
        const fingerprint = hash(JSON.stringify(stable({ tool: call.toolName, input: call.input })));
        if (current.limits.maxRepeatedFailures > 0 && fingerprint === lastFailure && consecutiveFailures >= current.limits.maxRepeatedFailures) {
          await limit("repeatedFailures"); return { block: true, terminate: true, reason: "相同工具操作连续失败，已停止重试。" };
        }
        const path = await outputPath(call.input.path);
        // New output files do not exist until the tool succeeds. Keep only a
        // bounded candidate, and validate its real filesystem path afterwards.
        const candidate = typeof call.input.path === "string" && call.input.path.length <= 4096
          && !/[\0\r\n]/.test(call.input.path) ? relative(workspace, resolve(workspace, call.input.path)) : "";
        const output = ["write", "edit"].includes(call.toolName) && candidate && !isAbsolute(candidate)
          && !candidate.split(/[\\/]/).includes("..") && !isProtectedWorkspacePath(candidate) ? candidate : undefined;
        pending.set(call.toolCallId, { id: call.toolCallId, tool: call.toolName, fingerprint, ...(path ? { path } : {}) });
        if (output) pending.get(call.toolCallId).output = output;
        event("tool_start", { tool: call.toolName, toolCallId: call.toolCallId, ...(path ? { path } : {}) });
        // Persist intent before allowing a side effect. An unknown result is never replayed.
        try { await persist(); }
        catch (error) {
          current.state = "interrupted";
          current.reason = "persistence";
          ready = false;
          throw error;
        }
        return {};
      });
    },
    toolResult(result) {
      return serial(async () => {
        if (!current) return;
        const call = pending.get(result.toolCallId);
        if (!call) return;
        pending.delete(result.toolCallId);
        if (result.isError) {
          consecutiveFailures = lastFailure === call.fingerprint ? consecutiveFailures + 1 : 1;
          lastFailure = call.fingerprint;
        } else { lastFailure = ""; consecutiveFailures = 0; }
        const path = !result.isError && call.output ? await outputPath(call.output) : call.path;
        if (!result.isError && call.output && path) current.artifacts = [...new Set([...(current.artifacts || []), path])].slice(-100);
        event("tool_end", { tool: call.tool, toolCallId: result.toolCallId, isError: !!result.isError, ...(path ? { path } : {}) });
        await persist();
      });
    },
    message(message) {
      return serial(async () => {
        if (!current || !["assistant", "toolResult"].includes(message?.role)) return;
        const identity = typeof message.id === "string" && message.id ? `${message.role}:${message.id}`
          : Number.isFinite(message.timestamp) ? `${message.role}:${message.timestamp}` : message;
        if (seenMessages.has(identity)) return;
        seenMessages.add(identity);
        if (message.role === "assistant") current.outcome = ["error", "aborted"].includes(message.stopReason) ? message.stopReason : undefined;
        const usage = message.usage;
        if (usage) {
          for (const key of ["input", "output", "cacheRead", "cacheWrite"])
            if (Number.isFinite(usage[key]) && usage[key] >= 0) current.usage.tokens += usage[key];
          if (Number.isFinite(usage.cost?.total) && usage.cost.total >= 0) current.usage.cost += usage.cost.total;
          else current.usage.costKnown = false;
        } else if (message.role === "assistant") current.usage.costKnown = false;
        await check(); await persist();
      });
    },
    externalUsage(usage) {
      return serial(async () => {
        if (!active(current)) return current?.reason || "inactive";
        if (!usage || typeof usage !== "object") {
          current.usage.costKnown = false;
          await persist();
          return "";
        }
        for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
          const value = usage[key];
          if (Number.isFinite(value) && value >= 0) current.usage.tokens += value;
        }
        if (Number.isFinite(usage.cost?.total) && usage.cost.total >= 0) current.usage.cost += usage.cost.total;
        else current.usage.costKnown = false;
        event("subagent_usage");
        const reason = await check();
        await persist();
        return reason;
      });
    },
    tick() { return serial(check); },
    end(outcome) {
      approvalController.abort();
      return serial(async () => {
        if (!active(current)) return;
        current.state = outcome === "cancelled" || current.outcome === "aborted" ? "cancelled"
          : outcome === "failed" || current.outcome === "error" ? "failed"
          : outcome === "interrupted" || pending.size ? "interrupted" : "awaiting_verification";
        event("end", { state: current.state }); await persist();
      });
    },
    async run(request, authority = "user") {
      return serial(async () => {
        if (!workspace || disposed || !ready) throw Error("任务控制器尚未就绪。");
        if (request.action === "status") {
          await reloadSettings();
          return { settings: { ...settings }, revision: revision(), current: snapshot(), workspace };
        }
        if (["verify", "history"].includes(request.action) && request.expectedWorkspace !== undefined && request.expectedWorkspace !== workspace)
          throw Error("项目已变化，请刷新后操作。");
        if (authority !== "user" && !["checkpoint", "progress"].includes(request.action)) throw Error("执行设置与验收只能由用户操作。");
        if (request.action === "progress") {
          if (!active(current)) throw Error("没有正在运行的任务。");
          if (request.steps !== undefined) {
            if (!Array.isArray(request.steps) || request.steps.length > 40 || request.steps.some(step => !step ||
              typeof step.title !== "string" || !step.title.trim() || step.title.length > 320 ||
              !["pending", "in_progress", "completed", "failed", "cancelled"].includes(step.status))) throw Error("无效的任务进度。");
          }
          if (request.artifacts !== undefined && (!Array.isArray(request.artifacts) || request.artifacts.length > 100)) throw Error("产物数量超过上限。");
          const artifacts = [];
          for (const path of request.artifacts || []) {
            const checked = await outputPath(path);
            if (!checked) throw Error("产物必须是工作区内已存在的非敏感普通文件。");
            artifacts.push(checked);
          }
          if (request.steps) current.plan = request.steps.map((step, index) => ({ id: String(index), title: redactWorkspaceText(step.title.trim(), 320), status: step.status }));
          current.artifacts = [...new Set([...(current.artifacts || []), ...artifacts])].slice(-100);
          await persist(); return snapshot();
        }
        if (request.action === "permissions") {
          if (request.expectedWorkspace !== workspace || typeof request.expectedRevision !== "string" || !modes.includes(request.mode))
            throw Error("项目或权限设置已变化，请刷新后操作。");
          const release = await lockSettings(`${settingsFile()}.lock`);
          try {
            await reloadSettings();
            if (request.expectedRevision !== revision()) throw Error("配置已被其他窗口修改，请刷新后重新编辑。");
            const previous = { ...settings }, previousMode = current?.limits.mode;
            const next = { ...settings, mode: request.mode };
            await write(settingsFile(), next);
            settings = next;
            try {
              if (active(current)) {
                current.limits.mode = request.mode;
                event("permission_mode", { mode: request.mode });
                await persist();
              }
            } catch (error) {
              settings = previous;
              if (current) current.limits.mode = previousMode;
              await write(settingsFile(), previous);
              throw error;
            }
            return { settings: { ...settings }, workspace, revision: revision(), current: snapshot() };
          } finally { await release(); }
        }
        if (request.action === "configure") {
          if (request.expectedWorkspace !== workspace || typeof request.expectedRevision !== "string")
            throw Error("项目已变化或配置尚未加载，请重新打开执行控制。");
          if (active(current)) throw Error("请先停止当前任务，再调整执行限制。");
          const next = harnessSettings(request.settings);
          const release = await lockSettings(`${settingsFile()}.lock`);
          try {
            await reloadSettings();
            if (request.expectedRevision !== revision()) throw Error("配置已被其他窗口修改，请刷新后重新编辑。");
            await write(settingsFile(), next);
            settings = next; return { settings: { ...settings }, workspace, revision: revision() };
          } finally { await release(); }
        }
        if (request.action === "checkpoint") {
          if (!active(current)) throw Error("没有正在运行的任务。");
          if (typeof request.note !== "string" || !request.note.trim() || request.note.length > 500) throw Error("检查点说明应为 1–500 个字符。");
          event("checkpoint", { note: redactWorkspaceText(request.note.trim(), 500) }); await persist(); return snapshot();
        }
        if (request.action === "history") {
          await ensure();
          const names = (await readdir(join(directory, "runs"))).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
          if (names.length > 2000) throw Error("任务记录超过 2000 项，请先备份管理记录。");
          const records = [], warnings = [];
          for (const name of names) {
            try {
            const value = await read(join(directory, "runs", name));
            if (value.version !== 1 || typeof value.workspace !== "string" || !Array.isArray(value.pending) ||
              value.pending.some(call => !call || typeof call.tool !== "string") || !Array.isArray(value.events) ||
              !value.usage || ["turns", "toolCalls", "tokens", "cost"].some(key => !Number.isFinite(value.usage[key]) || value.usage[key] < 0) ||
              typeof value.usage.costKnown !== "boolean" || !Number.isFinite(value.startedAt) || !Number.isFinite(value.updatedAt) ||
              typeof value.id !== "string" || typeof value.state !== "string" ||
              value.verification != null && typeof value.verification.note !== "string")
              throw Error("无效的任务记录");
            if (value.workspace !== workspace) continue;
            records.push({ id: value.id, state: value.state, reason: value.reason, startedAt: value.startedAt,
              updatedAt: value.updatedAt, sessionId: value.sessionId, usage: value.usage, pending: value.pending.slice(0, 20),
              unresolvedCount: value.pending.length, verification: value.verification,
              observation: value.state === "running" && value.id !== current?.id ? "unconfirmed" : "current" });
            } catch { warnings.push({ file: name, reason: "记录无法读取，原文件已保留。" }); }
          }
          const runs = records.sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
          return request.report === true ? { runs, warnings } : runs;
        }
        if (request.action === "verify") {
          if (!["passed", "failed"].includes(request.result) || typeof request.note !== "string" ||
            !request.note.trim() || request.note.length > 1000) throw Error("请填写验收结论和依据。");
          if (typeof request.id !== "string" || !/^[a-f0-9-]{36}$/.test(request.id)) throw Error("无效的任务 ID。");
          const target = current?.id === request.id ? current : await read(join(directory, "runs", `${request.id}.json`));
          if (target.workspace !== workspace || !["awaiting_verification", "verified", "verification_failed"].includes(target.state))
            throw Error("仅能验收当前项目中已结束且结果完整的任务。");
          target.verification = { result: request.result, note: redactWorkspaceText(request.note.trim(), 1000), at: now(), authority: "user" };
          target.state = request.result === "passed" ? "verified" : "verification_failed";
          target.events.push({ at: now(), type: "verification", result: request.result });
          target.events = target.events.slice(-200);
          target.updatedAt = now();
          await write(join(directory, "runs", `${target.id}.json`), target);
          return structuredClone(target);
        }
        throw Error("未知任务控制操作。");
      });
    },
    async dispose() {
      approvalController.abort();
      return serial(async () => {
        disposed = true;
        if (active(current)) { current.state = "interrupted"; event("interrupted"); await persist(); }
      });
    },
  };
}
