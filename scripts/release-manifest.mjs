import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseReleaseManifest } from "../src/release-manifest.ts";
const args = process.argv.slice(2);
const output = args.find(arg => arg.startsWith("--output="))?.slice(9);
if (!output) throw Error("Provide --output=<new manifest.json> and --artifact=<macOS|Windows>:<arm64|x64>:<file>");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const artifacts = [];
for (const value of args.filter(arg => arg.startsWith("--artifact="))) {
  const [platform, arch, ...parts] = value.slice(11).split(":");
  const file = resolve(parts.join(":")), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw Error("Artifact must be a regular file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  artifacts.push({ name: basename(file), platform, arch, bytes: info.size, sha256: hash.digest("hex") });
}
const manifest = parseReleaseManifest(JSON.stringify({
  schema: 1, product: "easy_pi", version: packageJson.version, publishedAt: new Date().toISOString(), artifacts,
}));
await writeFile(resolve(output), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log("Release manifest written. This does not certify publisher signing or platform acceptance.");
