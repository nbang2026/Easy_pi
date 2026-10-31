import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TASK_ROUTING_DOMAINS } from "./task-routing.mjs";
import { redactCredentials } from "./privacy.mjs";

export const MAX_SCHEDULE_TASKS = 6;
export const MAX_SCHEDULE_PARALLEL = 4;
const MAX_TASK_PROMPT_BYTES = 4096;
const MAX_SCHEDULE_BYTES = 24000;
const MAX_RESULT_CHARS = 12000;
const MAX_DEPENDENCY_RESULT_CHARS = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_LINES = 400;
const MAX_SEARCH_FILES = 400;
const MAX_SEARCH_HITS = 100;
const SKIP_DIRECTORIES = new Set([
  ".git", ".pi", ".ssh", ".aws", ".azure", ".gnupg", "node_modules",
  "vendor", "target", "dist", "build", ".next", ".nuxt",
]);
const SENSITIVE_NAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;

export const redactWorkspaceText = (value, limit = MAX_RESULT_CHARS) =>
  redactCredentials(value).slice(0, limit);
const cleanText = redactWorkspaceText;

export function isProtectedWorkspacePath(path) {
  return path.split(/[\\/]/).filter(Boolean).some(part =>
    [".git", ".pi", ".ssh", ".aws", ".azure", ".gnupg", ".codex", ".claude"].includes(part.toLowerCase())
    || SENSITIVE_NAMES.test(part));
}

const abortIfNeeded = (signal) => {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("任务已取消。");
};

function scheduleId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(value);
}

export function normalizeScheduleTasks(input, { maxTasks = MAX_SCHEDULE_TASKS } = {}) {
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > MAX_SCHEDULE_TASKS) {
    throw new Error("调度器任务上限无效。");
  }
  if (!Array.isArray(input) || input.length < 1 || input.length > maxTasks) {
    throw new Error(`本次最多安排 ${maxTasks} 项子任务。`);
  }
  const totalBytes = Buffer.byteLength(JSON.stringify(input));
  if (totalBytes > MAX_SCHEDULE_BYTES) throw new Error("子任务计划超过 24 KB，请缩小拆分范围。");
  const ids = new Set();
  const duplicateKeys = new Set();
  const tasks = input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("子任务格式无效。");
    const { id, title, domain, prompt } = item;
    if (!scheduleId(id) || ids.has(id)) throw new Error("子任务 ID 缺失、重复或格式无效。");
    if (typeof title !== "string" || !title.trim() || Buffer.byteLength(title) > 160) throw new Error("子任务标题应为 1–160 字节。");
    if (typeof domain !== "string" || !(TASK_ROUTING_DOMAINS.includes(domain) || domain === "general" || domain === "verification")) {
      throw new Error("子任务领域无效。");
    }
    if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > MAX_TASK_PROMPT_BYTES || /\0/.test(prompt)) {
      throw new Error("子任务说明应为 1–4096 字节。");
    }
    const dependsOn = item.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.length > maxTasks || dependsOn.some((value) => !scheduleId(value))) {
      throw new Error("子任务依赖列表无效。");
    }
    if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(id)) throw new Error("子任务不能依赖自身或重复依赖。");
    const duplicateKey = `${domain}\0${title.trim().normalize("NFKC").toLowerCase()}\0${prompt.trim().normalize("NFKC").toLowerCase()}`;
    if (duplicateKeys.has(duplicateKey)) throw new Error("计划中存在重复子任务，请合并后再提交。");
    duplicateKeys.add(duplicateKey);
    ids.add(id);
    return { id, title: title.trim(), domain, prompt: prompt.trim(), dependsOn: [...dependsOn] };
  });

  for (const task of tasks) {
    if (task.dependsOn.some((id) => !ids.has(id))) throw new Error(`子任务 ${task.id} 引用了不存在的依赖。`);
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error("子任务依赖形成循环，无法调度。");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  return tasks;
}

export function createTaskScheduler({ runTask } = {}) {
  if (typeof runTask !== "function") throw new TypeError("子任务执行器必填。");
  return {
    async run(input, { maxTasks = MAX_SCHEDULE_TASKS, maxConcurrency = MAX_SCHEDULE_PARALLEL, taskTimeoutMs = 300000, signal, onUpdate } = {}) {
      if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_SCHEDULE_PARALLEL) {
        throw new Error("并行 Agent 上限无效。");
      }
      if (!Number.isSafeInteger(taskTimeoutMs) || taskTimeoutMs < 0 || taskTimeoutMs > 86400000) {
        throw new Error("子任务超时时间无效。");
      }
      const tasks = normalizeScheduleTasks(input, { maxTasks });
      const runId = randomUUID();
      const states = new Map(tasks.map((task) => [task.id, {
        id: task.id, title: task.title, domain: task.domain, status: "pending",
        dependsOn: task.dependsOn, result: "", error: "",
        executionId: `${runId}:${task.id}`,
      }]));
      const active = new Map();
      const emit = (state) => {
        try { onUpdate?.({ ...state }); } catch { /* Progress reporting cannot change task results. */ }
      };
      const launch = (task) => {
        const state = states.get(task.id);
        state.status = "running";
        state.startedAt = Date.now();
        emit(state);
        const operation = (async () => {
          const controller = new AbortController();
          const cancel = () => controller.abort(signal.reason || new DOMException("任务已取消。", "AbortError"));
          const timer = taskTimeoutMs > 0 ? setTimeout(() => controller.abort(new Error("子任务执行超时。")), taskTimeoutMs) : undefined;
          signal?.addEventListener("abort", cancel, { once: true });
          let rejectAbort;
          const interrupted = new Promise((_resolve, reject) => { rejectAbort = () => reject(controller.signal.reason); });
          controller.signal.addEventListener("abort", rejectAbort, { once: true });
          try {
            abortIfNeeded(signal);
            const dependencies = task.dependsOn.map((id) => {
              const dependency = states.get(id);
              return {
                id: dependency.id,
                title: dependency.title,
                domain: dependency.domain,
                result: cleanText(dependency.result, MAX_DEPENDENCY_RESULT_CHARS),
              };
            });
            const result = await Promise.race([
              Promise.resolve().then(() => {
                abortIfNeeded(controller.signal);
                return runTask(task, { signal: controller.signal, dependencies, executionId: state.executionId, runId });
              }),
              interrupted,
            ]);
            abortIfNeeded(controller.signal);
            state.status = "completed";
            state.result = cleanText(result?.result ?? result?.text ?? result);
            if (typeof result?.agent === "string") state.agent = cleanText(result.agent, 120);
            if (Array.isArray(result?.skills)) state.skills = result.skills.map((value) => cleanText(value, 80)).slice(0, 8);
          } catch (error) {
            state.status = signal?.aborted || error?.name === "AbortError" ? "cancelled" : "failed";
            state.error = cleanText(error?.message || error, 800);
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
            controller.signal.removeEventListener("abort", rejectAbort);
            state.finishedAt = Date.now();
            emit(state);
          }
        })();
        active.set(task.id, operation);
        void operation.finally(() => active.delete(task.id));
      };

      while (true) {
        if (signal?.aborted) {
          for (const state of states.values()) {
            if (state.status === "pending") {
              state.status = "cancelled";
              state.error = "任务已取消。";
              emit(state);
            }
          }
        }
        for (const task of tasks) {
          const state = states.get(task.id);
          if (state.status !== "pending") continue;
          const dependencies = task.dependsOn.map((id) => states.get(id));
          if (dependencies.some((dependency) => ["failed", "cancelled", "skipped"].includes(dependency.status))) {
            state.status = "skipped";
            state.error = "依赖任务未成功完成。";
            emit(state);
          }
        }
        if (!signal?.aborted) {
          for (const task of tasks) {
            if (active.size >= maxConcurrency) break;
            const state = states.get(task.id);
            if (state.status !== "pending") continue;
            if (task.dependsOn.every((id) => states.get(id).status === "completed")) launch(task);
          }
        }
        if (active.size) {
          await Promise.race(active.values());
          continue;
        }
        if ([...states.values()].every((state) => state.status !== "pending")) break;
        // A valid acyclic graph always has a runnable node unless cancellation
        // or a dependency failure has already settled the remaining tasks.
        for (const state of states.values()) {
          if (state.status === "pending") {
            state.status = signal?.aborted ? "cancelled" : "skipped";
            state.error = signal?.aborted ? "任务已取消。" : "没有可执行的依赖任务。";
            emit(state);
          }
        }
        break;
      }
      return {
        ok: [...states.values()].every((state) => state.status === "completed"),
        completed: [...states.values()].filter((state) => state.status === "completed").length,
        failed: [...states.values()].filter((state) => state.status === "failed").length,
        cancelled: [...states.values()].filter((state) => state.status === "cancelled").length,
        runId,
        tasks: [...states.values()].map(({ dependsOn, ...state }) => ({ ...state, ...(dependsOn.length ? { dependsOn } : {}) })),
      };
    },
  };
}

function withinRoot(root, target) {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function isSensitivePath(path) {
  return path.split(sep).filter(Boolean).some((part) =>
    SKIP_DIRECTORIES.has(part.toLowerCase())) || isProtectedWorkspacePath(path);
}

async function checkedPath(root, supplied, kind, signal) {
  abortIfNeeded(signal);
  if (typeof supplied !== "string" || !supplied.trim() || supplied.includes("\0")) throw new Error("工作区路径无效。");
  const requested = resolve(root, supplied);
  if (!withinRoot(root, requested)) throw new Error("只允许访问当前项目工作区。");
  if (isSensitivePath(relative(root, requested))) throw new Error("为保护凭据和私密配置，子 Agent 不能读取此路径。");
  const target = await realpath(requested);
  if (!withinRoot(root, target)) throw new Error("只允许访问当前项目工作区。");
  if (isSensitivePath(relative(root, target))) throw new Error("为保护凭据和私密配置，子 Agent 不能读取此路径。");
  const stat = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).then(async (file) => {
    try { return await file.stat(); } finally { await file.close(); }
  });
  if (kind === "file" && !stat.isFile()) throw new Error("指定路径不是文件。");
  if (kind === "directory" && !stat.isDirectory()) throw new Error("指定路径不是文件夹。");
  return target;
}

async function readTextFile(path, signal) {
  abortIfNeeded(signal);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_FILE_BYTES) throw new Error("文件超过子 Agent 的读取上限，或为不允许的硬链接。");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      abortIfNeeded(signal);
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new Error("文件超过子 Agent 的读取上限。");
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) throw new Error("子 Agent 只读取文本文件。");
    abortIfNeeded(signal);
    // Redact before line selection or search, including multi-line secrets.
    return redactCredentials(bytes.toString("utf8"));
  } finally {
    await file.close();
  }
}

function toolResult(text, details) {
  return { content: [{ type: "text", text: cleanText(text, 24000) }], ...(details ? { details } : {}) };
}

export async function createTaskWorkspaceTools({ workspace, Type, harness, maxCalls = 24, trackCalls = true } = {}) {
  if (typeof workspace !== "string" || !workspace || !Type?.Object || !Type?.String || !Type?.Optional) {
    throw new Error("只读工作区工具配置无效。");
  }
  const root = await realpath(workspace);
  let calls = 0;
  const tracked = async (toolName, params, operation, signal) => {
    abortIfNeeded(signal);
    calls++;
    if (calls > maxCalls) throw new Error("子 Agent 已达到单次读取上限。");
    const toolCallId = `delegate-${randomUUID()}`;
    const policyName = { read: "workspace_read", ls: "workspace_list", grep: "workspace_search" }[toolName];
    const event = { toolCallId, toolName: policyName, input: { ...params } };
    const allowed = trackCalls ? await harness.beforeTool(event) : {};
    if (allowed?.block) throw new Error(allowed.reason || "当前任务权限不允许子 Agent 读取该路径。");
    try {
      const result = await operation(event.input, signal);
      if (trackCalls) await harness.toolResult({ toolCallId, isError: false });
      return result;
    } catch (error) {
      if (trackCalls) await harness.toolResult({ toolCallId, isError: true });
      throw error;
    }
  };
  return [
    {
      name: "workspace_read",
      label: "读取项目文件",
      description: "在当前项目工作区内读取一段文本文件。不可读取凭据、私密配置或工作区以外的文件。",
      parameters: Type.Object({
        path: Type.String({ description: "工作区内的相对文件路径" }),
        startLine: Type.Optional(Type.Number({ minimum: 1 })),
        endLine: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      async execute(_id, params, signal) {
        return tracked("read", params, async (input, activeSignal) => {
          const path = await checkedPath(root, input.path, "file", activeSignal);
          const content = await readTextFile(path, activeSignal);
          const lines = content.split(/\r?\n/);
          const start = Math.max(1, Number.isSafeInteger(input.startLine) ? input.startLine : 1);
          const end = Math.min(lines.length, Number.isSafeInteger(input.endLine) ? input.endLine : start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
          if (end < start) throw new Error("结束行不能早于起始行。");
          const excerpt = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
          return toolResult(excerpt || "(empty file)", { path: relative(root, path), startLine: start, endLine: end });
        }, signal);
      },
    },
    {
      name: "workspace_list",
      label: "列出项目文件",
      description: "列出当前项目内一个文件夹的名称和类型。跳过依赖、凭据及私密配置目录。",
      parameters: Type.Object({ path: Type.Optional(Type.String({ description: "工作区内的相对文件夹路径，默认为项目根目录" })) }),
      async execute(_id, params, signal) {
        return tracked("ls", { path: params.path || "." }, async (input, activeSignal) => {
          const path = await checkedPath(root, input.path, "directory", activeSignal);
          const entries = await readdir(path, { withFileTypes: true });
          const visible = entries.filter((entry) => !isSensitivePath(entry.name))
            .slice(0, 200).map((entry) => `${entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other"} ${entry.name}`);
          return toolResult(visible.join("\n") || "(empty folder)", { path: relative(root, path), truncated: entries.length > 200 });
        }, signal);
      },
    },
    {
      name: "workspace_search",
      label: "搜索项目内容",
      description: "在当前项目内按普通文本搜索。不是正则表达式；自动跳过依赖、构建产物、凭据和私密配置。",
      parameters: Type.Object({
        query: Type.String({ description: "要搜索的普通文本" }),
        path: Type.Optional(Type.String({ description: "工作区内的相对文件或文件夹路径，默认为项目根目录" })),
      }),
      async execute(_id, params, signal) {
        return tracked("grep", { path: params.path || "." }, async (input, activeSignal) => {
          if (typeof params.query !== "string" || !params.query.trim() || Buffer.byteLength(params.query) > 160 || /\0/.test(params.query)) {
            throw new Error("搜索词应为 1–160 字节。");
          }
          const target = await checkedPath(root, input.path, "directory", activeSignal).catch(async (error) => {
            if (error.message !== "指定路径不是文件夹。") throw error;
            return checkedPath(root, input.path, "file", activeSignal);
          });
          const matches = [];
          let inspected = 0;
          let skipped = 0;
          const needle = params.query.toLocaleLowerCase();
          const visit = async (path, depth) => {
            abortIfNeeded(activeSignal);
            if (matches.length >= MAX_SEARCH_HITS || inspected >= MAX_SEARCH_FILES || depth > 8) return;
            const entries = await readdir(path, { withFileTypes: true }).catch(error => {
              abortIfNeeded(activeSignal);
              if (path === target) throw error;
              skipped++;
              return [];
            });
            for (const entry of entries) {
              abortIfNeeded(activeSignal);
              if (matches.length >= MAX_SEARCH_HITS || inspected >= MAX_SEARCH_FILES) return;
              if (isSensitivePath(entry.name) || entry.isSymbolicLink()) continue;
              const child = resolve(path, entry.name);
              if (!withinRoot(root, child)) continue;
              if (entry.isDirectory()) { await visit(child, depth + 1); continue; }
              if (!entry.isFile()) continue;
              inspected++;
              const text = await readTextFile(child, activeSignal).catch(() => {
                abortIfNeeded(activeSignal);
                skipped++;
                return "";
              });
              if (!text || text.length > MAX_FILE_BYTES) continue;
              for (const [index, line] of text.split(/\r?\n/).entries()) {
                if (line.toLocaleLowerCase().includes(needle)) {
                  matches.push(`${relative(root, child)}:${index + 1}: ${line.slice(0, 500)}`);
                  if (matches.length >= MAX_SEARCH_HITS) return;
                }
              }
            }
          };
          const info = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).then(async (file) => {
            try { return await file.stat(); } finally { await file.close(); }
          });
          if (info.isFile()) {
            inspected++;
            const text = await readTextFile(target, activeSignal);
            for (const [index, line] of text.split(/\r?\n/).entries()) {
              if (line.toLocaleLowerCase().includes(needle)) matches.push(`${relative(root, target)}:${index + 1}: ${line.slice(0, 500)}`);
              if (matches.length >= MAX_SEARCH_HITS) break;
            }
          } else if (info.isDirectory()) {
            await visit(target, 0);
          } else {
            throw new Error("搜索路径不是文件或文件夹。");
          }
          const output = matches.join("\n") || "(no matches)";
          return toolResult(skipped ? `${output}\nSearch incomplete: ${skipped} files or directories could not be read.` : output, {
            inspected, skipped, truncated: skipped > 0 || inspected >= MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_HITS,
          });
        }, signal);
      },
    },
  ];
}
