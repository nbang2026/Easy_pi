import test from "node:test";
import assert from "node:assert/strict";
import { agentConfigDirectory, guiSkillsDirectory } from "../src-tauri/src/pi-paths.mjs";

const home = "/tmp/pi-agent-path-fixture";

test("agent config directory matches Pi override, tilde, and default roots", () => {
  assert.equal(agentConfigDirectory({ homeDirectory: home, environment: { PI_CODING_AGENT_DIR: "/tmp/custom-pi-agent" } }), "/tmp/custom-pi-agent");
  assert.equal(agentConfigDirectory({ homeDirectory: home, environment: { PI_CODING_AGENT_DIR: "~/custom-pi-agent" } }), `${home}/custom-pi-agent`);
  assert.equal(agentConfigDirectory({ homeDirectory: home, environment: { PI_CODING_AGENT_DIR: "" } }), `${home}/.pi/agent`);
  assert.equal(guiSkillsDirectory({ homeDirectory: home, environment: { PI_CODING_AGENT_DIR: "/tmp/custom-pi-agent" } }), "/tmp/custom-pi-agent/gui-skills");
});

test("explicit directory options retain precedence over configured Pi roots", () => {
  assert.equal(agentConfigDirectory({ directory: "/tmp/explicit-library", agentDirectory: "/tmp/agent-dir", environment: { PI_CODING_AGENT_DIR: "/tmp/env-dir" } }), "/tmp/explicit-library");
  assert.equal(agentConfigDirectory({ agentDirectory: "/tmp/agent-dir", environment: { PI_CODING_AGENT_DIR: "/tmp/env-dir" } }), "/tmp/agent-dir");
});
