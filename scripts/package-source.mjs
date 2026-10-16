import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const outputArgument = process.argv.find((arg) => arg.startsWith("--output="));
const output = outputArgument ? resolve(outputArgument.slice("--output=".length))
  : join(homedir(), "Desktop", "pi全版本", "Windows", `easy_pi-${metadata.version}`, `easy_pi-${metadata.version}-Windows-Source.zip`);
const prefix = `easy_pi-${metadata.version}-Windows-Source/`;
const files = {};
async function collect(directory, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "target", "dist", ".git", ".DS_Store", "runtime", "verification-report.json", "artifacts"].includes(entry.name)
      || entry.name.startsWith("._") || entry.name.startsWith(".windows-runtime-") || entry.name.startsWith(".model-visual")) continue;
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
if (!await lstat(runtime).then((value) => value.isFile(), () => false)) throw Error("Verified offline runtime archive is required in runtime-assets.");
await collect(root);
files[prefix + "README.md"] = strToU8(`# easy_pi ${metadata.version} — Windows source only

This archive contains source code and the pinned Pi runtime archive. No Windows application executable or installer is built; the offline runtime archive still contains its Node runtime binary.

Model settings include row checkboxes, select matching models, delete selected, clear all and restore removed models. All destructive list operations require in-app confirmation. Provider keys and endpoints are preserved.

Agent Market is available in Settings > Agent Market: offline original text-Agent catalog, search/categories, full-text preview, explicit import and separate activation. GitHub public Markdown/text preview is optional; no DSH plugin/theme/MCP/code installers are supported. See pi-app/市场来源与兼容范围.md for provenance and compatibility.

Application data remains under the existing Pi home directory. Names/identifiers for stored preferences are intentionally preserved.

From pi-app: install the project build dependencies with pnpm, prepare the runtime with node scripts/prepare-windows-runtime.mjs, then run pnpm check and pnpm test. Rust tests require the platform development toolchain.

The legacy scripts/verify-windows-installer.ps1 is not called by current source-only delivery. No Windows runtime execution is claimed by this archive.
`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, zipSync(files), { flag: "wx" });
console.log(`Source-only archive: ${output}`);
console.log(`Packaged source files: ${Object.keys(files).length}`);
