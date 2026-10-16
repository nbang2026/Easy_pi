import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pins, runtimeRoot, validateRuntime } from "./prepare-windows-runtime.mjs";

const argument = process.argv.find((value) => value.startsWith("--runtime="));
const runtime = argument ? resolve(argument.slice("--runtime=".length)) : runtimeRoot;
const errors = await validateRuntime(runtime);
if (errors.length) throw Error(errors.join("\n"));
if (process.platform !== "win32") {
  if (process.argv.includes("--require-windows")) throw Error("Native smoke test requires Windows.");
  console.log("PASS: Windows runtime files and checksums. SKIP: cannot execute node.exe on this host.");
} else {
  const home = await mkdtemp(join(tmpdir(), "nbpi-clean-home-"));
  try {
    const system = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const env = {
      SystemRoot: system, SYSTEMROOT: system, WINDIR: system,
      ComSpec: join(system, "System32/cmd.exe"), PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: home, TMP: home, HOME: home, USERPROFILE: home,
      APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
      PATH: [join(runtime, "node"), join(system, "System32"), system].join(";"),
      PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
    };
    await mkdir(env.APPDATA, { recursive: true });
    await mkdir(env.LOCALAPPDATA, { recursive: true });
    await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
    const node = join(runtime, pins.nodePath);
    function run(args) {
      const result = spawnSync(node, args, { env, cwd: home, encoding: "utf8", windowsHide: true, timeout: 30000 });
      if (result.error || result.status !== 0) throw Error(`Runtime smoke failed: ${result.error || result.stderr || result.stdout || result.status}`);
      return result.stdout.trim();
    }
    if (run(["--version"]) !== `v${pins.nodeVersion}`) throw Error("Node version mismatch.");
    const version = run([join(runtime, pins.entryPath), "--version"]);
    if (!version.includes(pins.piVersion)) throw Error(`Pi version mismatch: ${version}`);
    run([join(runtime, "node/node_modules/npm/bin/npm-cli.js"), "--version"]);
    run(["-e", "require('node:child_process').execFileSync('node.exe',['--version'],{stdio:'pipe'}); require(process.argv[1]);", join(runtime, "app/node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-platform.node")]);
    console.log(`PASS: isolated Windows Node ${pins.nodeVersion}, Pi ${version}, npm and native TUI module (no external runtime PATH).`);
  } finally { await rm(home, { recursive: true, force: true }); }
}
