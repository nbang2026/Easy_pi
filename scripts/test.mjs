import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["src", "scripts"].flatMap((dir) => readdirSync(resolve(root, dir)).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => `${dir}/${name}`));
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...files], { cwd: root, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
