import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function agentConfigDirectory(options = {}) {
  const home = options.homeDirectory || homedir();
  const environment = options.environment || process.env;
  const configured = options.directory || options.agentDirectory || environment.PI_CODING_AGENT_DIR;
  if (typeof configured === "string" && configured.length > 0) {
    if (configured === "~") return home;
    if (configured.startsWith("~/") || (process.platform === "win32" && configured.startsWith("~\\"))) {
      return join(home, configured.slice(2));
    }
    return resolve(configured);
  }
  return join(home, ".pi", "agent");
}

export function guiSkillsDirectory(options = {}) {
  return join(agentConfigDirectory(options), "gui-skills");
}
