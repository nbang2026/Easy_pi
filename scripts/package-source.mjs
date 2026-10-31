import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releaseVersion = metadata.version === "1.0.10-fix.1" ? "1.0.10fix1" : metadata.version;
const outputArgument = process.argv.find((arg) => arg.startsWith("--output="));
const platformArgument = process.argv.find((arg) => arg.startsWith("--platform="));
const platform = platformArgument ? platformArgument.slice("--platform=".length) : "Windows";
if (!["Windows", "Harmony", "macOS"].includes(platform)) throw Error("Supported source platforms are Windows, Harmony and macOS.");
const platformLabel = platform;
const output = outputArgument ? resolve(outputArgument.slice("--output=".length))
  : join(homedir(), "Desktop", "pi全版本", platform === "Harmony" ? "鸿蒙" : platform, `easy_pi-${releaseVersion}`, `easy_pi-${releaseVersion}-${platformLabel}-Source.zip`);
const prefix = `easy_pi-${releaseVersion}-${platformLabel}-Source/`;
const files = {};
async function collect(directory, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "target", "dist", ".git", ".DS_Store", "runtime", "claude-runtime", "verification-report.json", "artifacts", ".pi", ".claude", ".codex", ".cache", "auth.json", "credentials.json"].includes(entry.name)
      || /^\.env(?:\.|$)/i.test(entry.name) && !/^\.env\.(?:example|sample|template)$/i.test(entry.name)
      || /\.(?:log|pem|key|p12|pfx)$/i.test(entry.name)
      || entry.name.startsWith("._") || entry.name.startsWith(".windows-runtime-") || entry.name.startsWith(".model-visual")) continue;
    if (!relative && /^(?:verification-report(?:-.*)?\.json|macos-delivery(?:-.*)?\.(?:json|md)|bugfix-report-.*\.md)$/i.test(entry.name)) continue;
    if (entry.name === "runtime-assets" && platform === "macOS") continue;
    if (relative === "runtime-assets" && entry.name !== "windows-x64-offline.zip") continue;
    const path = join(directory, entry.name);
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw Error(`Refusing to package source symlink: ${name}`);
    if (entry.isDirectory()) await collect(path, name);
    else if (entry.isFile()) {
      const bytes = new Uint8Array(await readFile(path));
      files[prefix + "pi-app/" + name] = [bytes, { level: entry.name.endsWith(".zip") ? 0 : 6 }];
    }
  }
}
const runtime = join(root, "runtime-assets/windows-x64-offline.zip");
if (platform === "Windows" && !await lstat(runtime).then((value) => value.isFile(), () => false)) throw Error("Verified offline runtime archive is required in runtime-assets.");
await collect(root);
files[prefix + "README.md"] = strToU8(`# easy_pi ${releaseVersion} — ${platformLabel} source

This archive contains the current easy_pi source, including uncommitted source changes. ${platform === "Windows" ? "It also contains the pinned Windows x64 Pi runtime archive; no Windows application executable or installer is claimed by this macOS build host." : platform === "macOS" ? "This is a macOS source kit, not a prebuilt application. Install build dependencies following pi-app/README.md; Node/Pi and Claude runtime dependencies are not bundled in this source ZIP. Build outputs, caches, local credentials and logs are excluded." : "HarmonyOS application packaging and device validation must run in DevEco Studio on a HarmonyOS build host."}

Includes Pi core update notices: background checks, current/latest core versions and manual checking under Settings > Version & checks. Pi core and easy_pi application versions remain separate. Notices never execute an upgrade or restart a task.

Model settings use a searchable provider list with provider-level API address, protocol and secret settings alongside a provider-scoped model list. Stored credentials are never returned to the UI; a blank key preserves the saved value. Model search, multi-select, delete, clear and restore remain available, with bulk actions scoped to the selected provider and destructive actions confirmed in-app.

Agent Market provides Online / Built-in / Downloaded views. Browse and search the live Agency Agents and VoltAgent public GitHub catalogs without a model connection, preview complete text and download separately. Downloads verify pinned Git blob bytes and keep source/version/author/license metadata; activation stays separate. The 64 built-in text Agents and public GitHub text URL imports remain available. See pi-app/功能整合与在线Agent市场.md and pi-app/市场来源与兼容范围.md.

Pi, Claude and Auto are independent engine choices. Pi uses the local Pi runtime; Claude uses the staged Claude Agent SDK resources and its own connection settings, sessions and usage log; Auto selects one engine per request. Role Agents remain separate from engines. See pi-app/Claude-Agent接入说明.md and pi-app/统一模型与思考方式.md.

Settings > Skill Store connects on startup to skillstore.io, skills.sh and skillsmp.com, displays their public catalog entries and offers keyword search inside the app. Its lightweight Node service runs independently of Pi sessions and model credentials. Preview the complete SKILL.md and pinned folder before confirming download, then enable separately. References, scripts and assets remain in the local app-owned library; downloaded installers are not executed. Enabled skills use Pi's native discovery for both work modes. See pi-app/Skill库说明.md.

Application data remains under the existing Pi home directory; Claude's state is kept in its app-owned isolated directory. Names/identifiers for stored preferences are intentionally preserved.

Settings > Execution Control adds per-project tool policies, time/turn/tool/token/cost limits, durable task records and user verification. Settings > Usage Log adds recorded token/cost summaries, model/date filters, a calendar and native CSV/JSON exports for the selected engine. Project-scoped memory, safe workspace tools and stale-edit checks are included. See pi-app/Harness与消耗日志.md for defaults, privacy boundaries and limitations. These controls are not an operating-system sandbox or a durable automatic task scheduler; missing prices remain unknown.

From pi-app: install the project build dependencies with pnpm, then run pnpm check and pnpm test. Windows also runs node scripts/prepare-windows-runtime.mjs. Rust tests require the platform development toolchain.

The legacy scripts/verify-windows-installer.ps1 is not called by current source-only delivery. Platform signing, installer execution and device acceptance are not claimed by this archive.
`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, zipSync(files), { flag: "wx" });
console.log(`Source-only archive: ${output}`);
console.log(`Packaged source files: ${Object.keys(files).length}`);
