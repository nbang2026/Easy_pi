type Step = { id: string; title: string; status: string };
type Tool = Step & { path?: string; plan?: Step[]; output?: boolean };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const steps = (value: unknown): Step[] => Array.isArray(value) ? value.slice(0, 40).filter(object).map((item, i) => ({
  id: String(item.id || i).slice(0, 100), title: String(item.step || item.content || item.title || "").slice(0, 320),
  status: ["pending", "in_progress", "completed", "failed", "cancelled"].includes(item.status) ? item.status : "pending",
})).filter(item => item.title) : [];

export function workspaceOutputPath(value: unknown, workspace: string): string | undefined {
  if (typeof value !== "string" || !workspace || /[\0\r\n]/.test(value) || value.length > 4096) return;
  let path = value.replaceAll("\\", "/"), root = workspace.replaceAll("\\", "/").replace(/\/$/, "");
  if (!root) root = "/";
  const windows = /^[A-Za-z]:\//.test(root);
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
    const prefix = root === "/" ? "/" : `${root}/`;
    if (!(windows ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix))) return;
    path = path.slice(prefix.length);
  }
  if (!path || path.split("/").some(part => part === "..") || /^(?:~|[A-Za-z]:|\/)/.test(path)
    || path.split("/").some(part => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.azure|\.gnupg|\.git|\.codex|\.pi|\.claude|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i.test(part))) return;
  path = path.replace(/^(?:\.\/)+/, "");
  return path && path !== "." ? path : undefined;
}

export function createWorkProgress() {
  let runId = "", plan: Step[] = [];
  const tools = new Map<string, Tool>(), artifacts = new Map<string, string>();
  const retired = new Set<string>();
  const begin = (id: string) => {
    if (id && retired.has(id)) return false;
    if (id && id !== runId) {
      if (runId) retired.add(runId);
      while (retired.size > 100) retired.delete(retired.values().next().value!);
      runId = id; tools.clear(); plan = [];
    }
    return true;
  };
  const event = (value: unknown, workspace: string) => {
    if (!object(value) || value.type !== "tool" || typeof value.toolId !== "string") return;
    if (!begin(typeof value.runId === "string" ? value.runId : "")) return;
    const before = tools.get(value.toolId);
    const input = object(value.input) ? value.input : {};
    const name = String(value.name && value.name !== "Tool" ? value.name : before?.title || "Tool").slice(0, 100);
    const status = ["error", "failed", "denied"].includes(value.status) ? "failed"
      : ["complete", "completed"].includes(value.status) ? "completed" : value.status === "cancelled" ? "cancelled" : "in_progress";
    const next: Tool = { ...before, id: value.toolId, title: name, status };
    const path = workspaceOutputPath(input.file_path || input.path || input.notebook_path, workspace);
    if (path) next.path = path;
    if (/^(?:write|edit|multiedit|notebookedit)$/i.test(name)) next.output = true;
    const reportedPlan = steps(input.todos || input.plan || (name === "gui_workbench" ? input.steps : undefined));
    if (reportedPlan.length) next.plan = reportedPlan;
    tools.set(value.toolId, next);
    if (tools.size > 100) tools.delete(tools.keys().next().value!);
    if (status === "completed") {
      if (next.plan?.length) plan = next.plan;
      if (next.output && next.path) artifacts.set(next.path, next.path);
    }
    while (artifacts.size > 100) artifacts.delete(artifacts.keys().next().value!);
  };
  return {
    event,
    task(value: unknown, workspace: string) {
      if (!object(value)) return;
      if (!begin(String(value.id || ""))) return;
      if (Array.isArray(value.plan)) plan = steps(value.plan);
      for (const item of Array.isArray(value.events) ? value.events : []) {
        if (!object(item) || !["tool_start", "tool_end"].includes(item.type) || !item.toolCallId) continue;
        event({ type: "tool", runId, toolId: item.toolCallId, name: item.tool,
          input: { path: item.path }, status: item.type === "tool_start" ? "running" : item.isError ? "error" : "complete" }, workspace);
      }
      for (const item of Array.isArray(value.artifacts) ? value.artifacts : []) {
        const path = workspaceOutputPath(item, workspace); if (path) artifacts.set(path, path);
      }
      if (["failed", "cancelled", "limited", "interrupted"].includes(value.state)) {
        plan = plan.map(step => step.status === "in_progress" ? { ...step, status: value.state === "cancelled" ? "cancelled" : "failed" } : step);
        for (const tool of tools.values()) if (tool.status === "in_progress") tool.status = value.state === "cancelled" ? "cancelled" : "failed";
      }
    },
    snapshot: () => ({ steps: plan.length ? plan : [...tools.values()].map(({ id, title, status, path }) => ({ id, title: path ? `${title} · ${path}` : title, status })), artifacts: [...artifacts.keys()] }),
    reset() { runId = ""; plan = []; tools.clear(); artifacts.clear(); retired.clear(); },
  };
}
