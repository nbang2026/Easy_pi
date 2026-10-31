import { icon } from "./icons.ts";
import { formatUserError } from "./utils.ts";

type Limits = { mode: string; maxMinutes: number; maxTurns: number; maxToolCalls: number; maxTokens: number; maxCost: number; maxRepeatedFailures: number };
type Run = { id: string; state: string; reason?: string; updatedAt: number; startedAt: number; observation?: string;
  limits?: Limits;
  usage: { turns: number; toolCalls: number; tokens: number; cost: number; costKnown: boolean };
  pending: { tool: string }[]; events: { at: number; type: string; tool?: string; note?: string; isError?: boolean }[];
  verification?: { note: string } };
const labels: Record<string, [string, string]> = {
  running: ["运行中", "Running"], awaiting_verification: ["运行结束 · 待验收", "Ended · Awaiting verification"],
  verified: ["验收通过", "Accepted"], verification_failed: ["验收未通过", "Verification failed"],
  failed: ["执行失败", "Failed"], cancelled: ["已取消", "Cancelled"], interrupted: ["已中断 · 核对副作用后继续", "Interrupted · Reconcile side effects"],
  limited: ["达到限制", "Limit reached"], time: ["运行时长", "Time"], tokens: ["Token", "Token"], cost: ["记录费用", "Recorded cost"],
  turns: ["模型轮数", "Turns"], toolCalls: ["工具次数", "Tool calls"], repeatedFailures: ["连续相同失败", "Repeated failures"],
  duplicateCall: ["重复调用 ID", "Duplicate call ID"], tool_start: ["开始", "Started"], tool_end: ["返回", "Returned"],
  checkpoint: ["检查点", "Checkpoint"], blocked: ["已阻止", "Blocked"], start: ["任务开始", "Started"],
  end: ["运行结束", "Ended"], turn: ["新轮次", "Turn"], verification: ["用户验收", "User verification"],
  permission_mode: ["权限模式变更", "Permission mode changed"],
};
export function setupHarnessSettings(options: {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  language(): string;
  engine?(): string;
  configured?(): void;
}) {
  const pane = document.getElementById("pane-harness")!;
  const en = () => options.language() === "en";
  const text = (zh: string, english: string) => en() ? english : zh;
  const label = (key: string) => labels[key]?.[en() ? 1 : 0] || key;
  let current: Run | null = null, dirty = false, busy = false, disposed = false, generation = 0;
  let workspace = "", revision = "", loading = false, evidenceIdentity = "";
  let loadedEngine = "", appliedMode = "", claudeTarget: { cwd: string; sessionId: string | null } | undefined;
  let permissionError = "";
  const engine = () => options.engine?.() || "pi";
  const drafts = new Map<string, { settings: Record<string, string>; revision: string }>();
  const evidence = new Map<string, string>();
  const request = async <T>(value: Record<string, unknown>) =>
    (await options.invoke<{ data: T }>("gui_action", { action: "harness", text: JSON.stringify(value) })).data;
  const el = <T extends HTMLElement>(id: string) => pane.querySelector<T>(`#${id}`)!;
  const rememberDraft = () => {
    if (!dirty || !workspace) return;
    drafts.set(workspace, { revision, settings: Object.fromEntries(
      [...el("harness-form").querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")]
        .map(input => [input.id, input instanceof window.HTMLInputElement && input.type === "checkbox" ? String(input.checked) : input.value])) });
  };
  const evidenceKey = (id: string) => JSON.stringify([workspace, id]);
  const setEvidence = (key: string, value: string) => {
    evidence.set(key, value);
    if (evidenceIdentity === key) el<HTMLTextAreaElement>("harness-evidence").value = value;
    pane.querySelectorAll<HTMLTextAreaElement>("[data-evidence-key]").forEach(input => {
      if (input.dataset.evidenceKey === key) input.value = value;
    });
  };
  const changeWorkspace = (next: string) => {
    if (next === workspace) return false;
    rememberDraft(); workspace = next; revision = ""; dirty = false; generation++; current = null;
    evidenceIdentity = ""; el<HTMLTextAreaElement>("harness-evidence").value = "";
    el("harness-history").replaceChildren();
    el("harness-workspace").textContent = workspace;
    return true;
  };
  const build = () => {
    pane.innerHTML = `<form id="harness-form">
      <div class="section-heading"><h3>${text("权限与执行", "Permissions & execution")}</h3><button id="harness-refresh" class="icon-button" type="button"></button></div>
      <p id="harness-workspace" class="settings-hint"></p>
      <div class="harness-permissions-actions"><button id="harness-full-access" type="button"></button><button id="harness-restore-permissions" type="button"></button><span id="harness-permission-state" role="status"></span></div>
      <p class="settings-hint">${text("完全访问会放行当前引擎的文件、命令和联网工具，并批准等待中的工具申请。自动补齐 Agent 与 Skill 仍受“Agent 与记忆”中的独立开关控制。恢复逐次确认后会立即阻断后续自动下载；macOS 隐私权限仍需系统授权。", "Full access allows files, commands and network tools for the active engine, and approves pending tool requests. Automatic Agent/Skill downloads still follow their separate switch in Agents & memory. Restoring approvals immediately blocks subsequent automatic downloads; macOS privacy access still requires system authorization.")}</p>
      <label class="harness-field">${text("工具权限", "Tool permissions")}<select id="harness-mode" class="settings-input">
      <option value="readonly">${text("只读项目工具", "Read-only project tools")}</option>
      <option value="confirm">${text("逐次确认 · 编辑与 Shell 需批准", "Ask each time · Edits and shell")}</option>
      <option value="project">${text("自动接受项目编辑 · Shell 逐次确认", "Auto-accept project edits · Ask for shell")}</option>
      <option value="autonomous">${text("自主执行 · 沿用 Pi 权限", "Autonomous · Existing Pi permissions")}</option></select></label>
      <p class="settings-hint">${text("Pi：只读模式始终拒绝写入和 Shell；逐次确认与项目编辑模式会在执行前弹出单次审批，拒绝或超时不会执行。自主模式不再逐次审批，请谨慎使用。Shell 不是项目沙箱。设置按项目保存，新任务生效；不隔离扩展或后台进程，也不授予系统权限。", "Pi: read-only blocks writes and shell. Ask-each-time and project-edit modes request approval before execution; denial or timeout blocks the operation. Autonomous mode skips individual approvals. Shell is not a project sandbox. Saved per project for new runs; extensions and background processes are not isolated, and OS permissions are not granted.")}</p>
      <label class="harness-field"><span><input id="harness-unlimited" type="checkbox" aria-controls="harness-limits"> ${text("无限制", "Unlimited")}</span></label>
      <p class="settings-hint">${text("开启后不设时长、轮数、工具、Token、费用及连续失败额度；关闭后显示自定义限制，单项填 0 表示不限制。停止按钮和工具权限审批不受影响。设置保存后对新任务生效。", "Disable time, turn, tool, token, cost and repeated-failure limits. Turn off to customize; 0 disables an individual limit. Stop and permission approvals remain available. Saved settings apply to new runs.")}</p>
      <div id="harness-limits" class="harness-limits"></div>
      <button id="harness-save" type="submit" class="primary-button">${text("保存限制", "Save limits")}</button>
      </form><p id="harness-message" class="settings-hint" role="status"></p>
      <section class="harness-current"><h3>${text("当前任务", "Current run")}</h3><div id="harness-run" aria-live="polite"></div>
      <label class="harness-field">${text("验收依据", "Verification evidence")}<textarea id="harness-evidence" class="settings-input" maxlength="1000" rows="2"></textarea></label>
      <div class="settings-options"><button id="harness-pass" type="button">${text("确认验收通过", "Accept result")}</button><button id="harness-fail" type="button">${text("验收未通过", "Reject result")}</button></div>
      <details><summary>${text("执行记录", "Execution log")}</summary><ol id="harness-events" class="harness-events"></ol></details></section>
      <details><summary>${text("历史任务（最近 50 项）", "Recent runs (50)")}</summary><div id="harness-history" class="harness-history"></div></details>`;
    const refresh = el<HTMLButtonElement>("harness-refresh");
    const fullAccess = el<HTMLButtonElement>("harness-full-access");
    fullAccess.append(icon("shield-alert"), text("一键放行所有权限", "Allow all tool permissions"));
    const restore = el<HTMLButtonElement>("harness-restore-permissions");
    restore.append(icon("shield-check"), text("恢复逐次确认", "Restore approvals"));
    fullAccess.addEventListener("click", () => { void operation(() => setPermissions(true)); });
    restore.addEventListener("click", () => { void operation(() => setPermissions(false)); });
    refresh.append(icon("refresh-cw")); refresh.title = text("刷新", "Refresh"); refresh.setAttribute("aria-label", refresh.title);
    const names: [keyof Limits, string, string, number, number, string][] = [
      ["maxMinutes", "最长分钟数", "Minutes", 0, 1440, "1"], ["maxTurns", "模型轮数", "Model turns", 0, 10000, "1"],
      ["maxToolCalls", "工具次数", "Tool calls", 0, 10000, "1"], ["maxTokens", "Token 上限（响应后核对）", "Tokens (checked after response)", 0, 100000000, "1"],
      ["maxCost", "记录美元上限（响应后核对）", "Recorded USD (after response)", 0, 10000, "0.01"],
      ["maxRepeatedFailures", "相同操作连续失败上限", "Repeated failure limit", 0, 20, "1"],
    ];
    for (const [key, zh, english, min, max, step] of names) {
      const wrapper = document.createElement("label"); wrapper.className = "harness-field"; wrapper.textContent = text(zh, english);
      const input = document.createElement("input"); input.type = "number"; input.id = `harness-${key}`;
      input.className = "settings-input"; input.min = String(min); input.max = String(max); input.step = step; input.required = true;
      wrapper.append(input); el("harness-limits").append(wrapper);
    }
    el("harness-workspace").textContent = workspace;
    el("harness-unlimited").addEventListener("change", () => {
      if (!el<HTMLInputElement>("harness-unlimited").checked) {
        const defaults = [30, 100, 200, 500000, 5, 3];
        if (names.every(([key]) => Number(el<HTMLInputElement>(`harness-${key}`).value) === 0)) {
          names.forEach(([key], index) => { el<HTMLInputElement>(`harness-${key}`).value = String(defaults[index]); });
        }
      }
      dirty = true; rememberDraft(); renderRun();
    });
    el("harness-form").addEventListener("input", () => { dirty = true; rememberDraft(); });
    el("harness-evidence").addEventListener("input", () => {
      if (current) setEvidence(evidenceKey(current.id), el<HTMLTextAreaElement>("harness-evidence").value);
    });
    refresh.addEventListener("click", () => {
      if (dirty && !window.confirm(text("放弃当前项目未保存的限制并重新加载？", "Discard unsaved limits and reload this project?"))) return;
      drafts.delete(workspace); dirty = false; void load();
    });
    el("harness-form").addEventListener("submit", event => {
      event.preventDefault(); if (busy || loading || !revision || options.engine?.() === "claude") return;
      const expectedWorkspace = workspace, expectedRevision = revision;
      const settings: Record<string, string | number> = { mode: el<HTMLSelectElement>("harness-mode").value };
      for (const [key] of names) settings[key] = el<HTMLInputElement>("harness-unlimited").checked ? 0 : el<HTMLInputElement>(`harness-${key}`).valueAsNumber;
      void operation(async () => {
        await request({ action: "configure", settings, expectedWorkspace, expectedRevision });
        drafts.delete(expectedWorkspace);
        options.configured?.();
        if (disposed || workspace !== expectedWorkspace) return;
        dirty = false; await load();
      });
    });
    for (const [id, result] of [["harness-pass", "passed"], ["harness-fail", "failed"]]) {
      el(id).addEventListener("click", () => {
        const note = el<HTMLTextAreaElement>("harness-evidence").value;
        const id = current?.id, expectedWorkspace = workspace;
        void operation(async () => {
          const resultRun = await request<Run>({ action: "verify", id, result, note, expectedWorkspace });
          if (id && evidence.get(evidenceKey(id)) === note) evidence.delete(evidenceKey(id));
          if (!disposed && workspace === expectedWorkspace && current?.id === id) { current = resultRun; renderRun(); }
        });
      });
    }
  };
  const renderRun = () => {
    const claude = options.engine?.() === "claude";
    const full = claude ? appliedMode === "full" : (current?.state === "running" ? current.limits?.mode || appliedMode : appliedMode) === "autonomous";
    const permissionsReady = loadedEngine === engine() && (claude ? !!claudeTarget : !!revision);
    el<HTMLButtonElement>("harness-full-access").disabled = busy || loading || !permissionsReady || full;
    el<HTMLButtonElement>("harness-restore-permissions").disabled = busy || loading || !permissionsReady || !full;
    el("harness-permission-state").textContent = !permissionsReady ? text("正在读取权限…", "Loading permissions…")
      : full ? text("完全访问已开启", "Full access enabled") : text("受控权限", "Controlled permissions");
    const identity = current ? evidenceKey(current.id) : "";
    if (identity !== evidenceIdentity) {
      evidenceIdentity = identity;
      el<HTMLTextAreaElement>("harness-evidence").value = identity ? evidence.get(identity) || "" : "";
    }
    const output = el("harness-run");
    output.textContent = !current ? text("暂无任务", "No runs yet") :
      `${label(current.state)}${current.reason ? ` · ${label(current.reason)}` : ""}\n${current.usage.turns} ${text("轮", "turns")} · ${current.usage.toolCalls} ${text("工具调用", "tool calls")} · ${current.usage.tokens.toLocaleString()} tokens · ${current.usage.costKnown ? `$${current.usage.cost.toFixed(4)}` : text("费用不完整", "Cost incomplete")}${current.pending.length ? `\n${text("结果待核对的工具", "Tools with unresolved results")}: ${current.pending.map(item => item.tool).join(", ")}` : ""}`;
    const canVerify = !!current && ["awaiting_verification", "verified", "verification_failed"].includes(current.state);
    for (const id of ["harness-pass", "harness-fail"]) el<HTMLButtonElement>(id).disabled = claude || busy || !canVerify;
    el<HTMLButtonElement>("harness-save").disabled = claude || busy || loading || !revision || current?.state === "running";
    el("harness-form").querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")
      .forEach(input => { input.disabled = claude || busy || loading || !revision; });
    const unlimited = el<HTMLInputElement>("harness-unlimited").checked;
    el("harness-limits").hidden = unlimited;
    if (unlimited) el("harness-limits").querySelectorAll<HTMLInputElement>("input").forEach(input => { input.disabled = true; });
    if (permissionError) el("harness-message").textContent = permissionError;
    else if (claude) el("harness-message").textContent = text("当前为 Claude 引擎：上方按钮控制其独立审批，本次应用会话按项目生效。下面的 Pi 模式和任务限制不适用于 Claude；自动选择跟随实际引擎。", "Claude has independent approvals. The buttons apply per project for this app session. Pi modes and task limits below do not apply to Claude; Auto follows the active engine.");
    el<HTMLButtonElement>("harness-refresh").disabled = busy || loading;
    el("harness-history").querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = busy || loading; });
    const events = el("harness-events"); events.replaceChildren();
    for (const entry of (current?.events || []).slice(-50).reverse()) {
      const item = document.createElement("li");
      item.textContent = `${new Date(entry.at).toLocaleTimeString()} · ${label(entry.type)}${entry.tool ? ` · ${entry.tool}` : ""}${entry.isError ? ` · ${text("失败", "Error")}` : ""}${entry.note ? ` · ${entry.note}` : ""}`;
      events.append(item);
    }
  };
  const operation = async (action: () => Promise<void>) => {
    if (busy || disposed) return;
    busy = true; permissionError = ""; renderRun();
    const operationWorkspace = workspace;
    try { await action(); }
    catch (error) { if (!disposed && workspace === operationWorkspace) permissionError = formatUserError(error); }
    finally { busy = false; if (!disposed) renderRun(); }
  };
  const load = async () => {
    const version = ++generation;
    const requestedEngine = engine();
    permissionError = "";
    if (requestedEngine === "claude") {
      loading = true; loadedEngine = ""; claudeTarget = undefined; renderRun();
      try {
        const value = await options.invoke<{ cwd: string; sessionId: string | null; permissionMode?: string }>("claude_action", { action: "status" });
        if (disposed || version !== generation || engine() !== requestedEngine) return;
        claudeTarget = { cwd: value.cwd, sessionId: value.sessionId || null };
        el("harness-workspace").textContent = value.cwd;
        appliedMode = value.permissionMode || "ask"; loadedEngine = requestedEngine;
      } catch (error) { if (!disposed && version === generation) permissionError = formatUserError(error); }
      finally { if (!disposed && version === generation) { loading = false; renderRun(); } }
      return;
    }
    const requestedWorkspace = workspace;
    loading = true; renderRun();
    try {
      const value = await request<{ settings: Limits; current: Run | null; workspace: string; revision: string }>({ action: "status" });
      if (disposed || version !== generation || engine() !== requestedEngine) return;
      if (requestedWorkspace && value.workspace !== requestedWorkspace) throw Error(text("项目已变化，请重新打开执行控制。", "Project changed. Reopen execution control."));
      if (workspace !== value.workspace) {
        rememberDraft(); workspace = value.workspace; dirty = false; evidenceIdentity = "";
      }
      el("harness-workspace").textContent = workspace;
      current = value.current;
      loadedEngine = requestedEngine; appliedMode = value.settings.mode;
      const draft = drafts.get(workspace);
      if (draft) {
        dirty = true; revision = draft.revision;
        for (const [id, settingValue] of Object.entries(draft.settings)) {
          const input = el<HTMLInputElement>(id);
          if (input.type === "checkbox") input.checked = settingValue === "true";
          else input.value = settingValue;
        }
      } else {
        revision = value.revision;
        for (const [key, settingValue] of Object.entries(value.settings)) el<HTMLInputElement>(`harness-${key}`).value = String(settingValue);
        el<HTMLInputElement>("harness-unlimited").checked = Object.entries(value.settings)
          .filter(([key]) => key !== "mode").every(([, limit]) => limit === 0);
      }
      renderRun();
      const report = await request<Run[] | { runs: Run[]; warnings: { file: string }[] }>({ action: "history", report: true, expectedWorkspace: workspace });
      const history = Array.isArray(report) ? report : report.runs;
      if (disposed || version !== generation || engine() !== requestedEngine) return;
      el("harness-history").replaceChildren();
      for (const run of history) {
        const detail = document.createElement("details"), summary = document.createElement("summary"), body = document.createElement("pre");
        summary.textContent = `${new Date(run.startedAt).toLocaleString()} · ${run.observation === "unconfirmed" ? text("状态待核对", "Status unconfirmed") : label(run.state)}`;
        body.textContent = `${run.id}\n${run.usage.toolCalls} tool calls · ${run.usage.tokens} tokens\n${run.pending.map(item => `${item.tool}: ${text("结果未知，勿自动重放", "Unknown outcome; do not replay")}`).join("\n")}${run.verification ? `\n${run.verification.note}` : ""}`;
        detail.append(summary, body); el("harness-history").append(detail);
        if (["awaiting_verification", "verified", "verification_failed"].includes(run.state)) {
          const note = document.createElement("textarea"); note.className = "settings-input"; note.maxLength = 1000;
          const key = evidenceKey(run.id), runWorkspace = workspace;
          note.value = evidence.get(key) ?? run.verification?.note ?? "";
          note.dataset.evidenceKey = key;
          note.addEventListener("input", () => { setEvidence(key, note.value); });
          note.setAttribute("aria-label", text("验收依据", "Verification evidence"));
          detail.append(note);
          for (const result of ["passed", "failed"]) {
            const button = document.createElement("button"); button.type = "button";
            button.textContent = result === "passed" ? text("确认验收通过", "Accept result") : text("验收未通过", "Reject result");
            button.addEventListener("click", () => { void operation(async () => {
              const submitted = note.value;
              await request({ action: "verify", id: run.id, result, note: submitted, expectedWorkspace: runWorkspace });
              if (evidence.get(key) === submitted) evidence.delete(key);
              if (!disposed && workspace === runWorkspace) await load();
            }); });
            detail.append(button);
          }
        }
      }
      el("harness-message").textContent = !Array.isArray(report) && report.warnings.length
        ? text(`${report.warnings.length} 条记录无法读取，原文件已保留；其余任务正常显示。`, `${report.warnings.length} unreadable records preserved; remaining runs are shown.`) : "";
    } catch (error) { if (!disposed && version === generation) { revision = ""; el("harness-message").textContent = formatUserError(error); } }
    finally { if (!disposed && version === generation) { loading = false; renderRun(); } }
  };
  const setPermissions = async (full: boolean) => {
    const requestedEngine = engine();
    if (loadedEngine !== requestedEngine) throw Error(text("请先刷新权限设置。", "Refresh permissions first."));
    if (requestedEngine === "claude") {
      if (!claudeTarget) throw Error(text("Claude 尚未连接。", "Claude is not connected."));
      const value = await options.invoke<{ permissionMode: string }>("claude_action", { action: "permissions", payload: {
        mode: full ? "full" : "ask", expectedWorkspace: claudeTarget.cwd, expectedSessionId: claudeTarget.sessionId,
      } });
      if (!disposed && engine() === requestedEngine) appliedMode = value.permissionMode;
    } else {
      if (!revision || !workspace) throw Error(text("请先刷新项目权限。", "Refresh project permissions first."));
      const expectedWorkspace = workspace;
      const value = await request<{ settings: Limits; current: Run | null; revision: string }>({ action: "permissions",
        mode: full ? "autonomous" : "confirm", expectedWorkspace, expectedRevision: revision });
      if (disposed || workspace !== expectedWorkspace || engine() !== requestedEngine) return;
      appliedMode = value.settings.mode; revision = value.revision; current = value.current;
      el<HTMLSelectElement>("harness-mode").value = appliedMode;
      if (dirty) rememberDraft();
      options.configured?.();
    }
    if (!disposed && engine() === requestedEngine) {
      renderRun();
      if (requestedEngine === "pi") el("harness-message").textContent = full ? text("完全访问已生效。", "Full access is active.") : text("已恢复逐次确认。", "Approval prompts restored.");
    }
  };
  build(); renderRun();
  return { refresh: load, async allowAll(expectedEngine = engine()) {
    if (disposed || busy) throw Error(text("权限设置正在处理中。", "Permission settings are busy."));
    if (engine() !== expectedEngine) throw Error(text("引擎已切换，请重新打开权限设置。", "Engine changed. Reopen permissions."));
    await load();
    if (disposed || loading || engine() !== expectedEngine || loadedEngine !== expectedEngine) throw Error(text("权限设置尚未就绪。", "Permissions are not ready."));
    busy = true; renderRun();
    try { await setPermissions(true); } finally { busy = false; if (!disposed) renderRun(); }
  }, observe(task: unknown, cwd?: string) {
    if (disposed) return;
    const changed = cwd ? changeWorkspace(cwd) : false;
    if (task === null || task && typeof task === "object") current = task as Run | null;
    if (!pane.hidden) { renderRun(); if (changed) void load(); }
  }, refreshLanguage() {
    if (dirty || el<HTMLTextAreaElement>("harness-evidence").value.trim()) return;
    build(); renderRun(); if (!pane.hidden) void load();
  }, dispose() { disposed = true; generation++; } };
}
