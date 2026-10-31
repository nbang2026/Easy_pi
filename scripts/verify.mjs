import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argument = process.argv.find((value) => value.startsWith("--report="));
const reportPath = resolve(root, argument ? argument.slice("--report=".length) : "verification-report.json");
const report = { checkedAt: new Date().toISOString(), passed: true, stages: [] };
const stages = [
  { name: "TypeScript", program: process.execPath, args: [resolve(root, "node_modules/typescript/bin/tsc"), "--noEmit"], cwd: root },
  { name: "Frontend tests", program: process.execPath, args: ["scripts/test.mjs"], cwd: root },
  { name: "Harness scenarios", program: process.execPath, args: ["scripts/harness-eval.mjs"], cwd: root },
  { name: "Frontend build", program: process.execPath, args: [resolve(root, "node_modules/vite/bin/vite.js"), "build"], cwd: root },
  { name: "Rust tests", program: "cargo", args: ["test", "--lib"], cwd: resolve(root, "src-tauri") },
  ...(process.env.PI_GUI_SMOKE_EXECUTABLE || process.env.PI_GUI_SMOKE_RUNTIME ? [{
    name: "Native Pi transport", program: "cargo",
    args: ["test", "--lib", "gui_bridge::tests::real_pi_launch_uses_the_app_transport", "--", "--ignored", "--exact"],
    cwd: resolve(root, "src-tauri"),
  }] : []),
];
for (const stage of stages) {
  console.log(`\nChecking: ${stage.name}`);
  const started = Date.now();
  const exitCode = await new Promise((done) => {
    const child = spawn(stage.program, stage.args, { cwd: stage.cwd, stdio: "inherit", env: process.env });
    child.once("error", (error) => { console.error(error.message); done(-1); });
    child.once("close", (code) => done(code ?? -1));
  });
  report.stages.push({ name: stage.name, passed: exitCode === 0, exitCode, durationMs: Date.now() - started });
  if (exitCode !== 0) report.passed = false;
}
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(`\n${report.passed ? "PASS" : "FAIL"}: ${reportPath}`);
process.exitCode = report.passed ? 0 : 1;
