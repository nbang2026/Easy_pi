import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export async function checkReleaseGate(file) {
  const path = await realpath(file), root = dirname(path);
  const report = JSON.parse(await readFile(path, "utf8"));
  const required = ["security", "stability", "experience", "features", "installation", "engineering"];
  const failures = [];
  if (report.schema !== 1 || report.product !== "easy_pi") failures.push("Invalid acceptance format");
  for (const key of required) {
    const section = report.criteria?.[key];
    if (section?.status !== "passed" || !Array.isArray(section.evidence) || !section.evidence.length) {
      failures.push(`${key}: acceptance evidence required`); continue;
    }
    for (const value of section.evidence) {
      try {
        if (typeof value !== "string" || isAbsolute(value)) throw Error();
        const target = resolve(root, value), info = await lstat(target), actual = await realpath(target), within = relative(root, actual);
        if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || isAbsolute(within) || within.startsWith("..")) throw Error();
      } catch { failures.push(`${key}: invalid or missing evidence file`); }
    }
  }
  for (const platform of ["macOS", "Windows"]) {
    if (report.platforms?.[platform]?.desktop !== "passed" || report.platforms?.[platform]?.install !== "passed" ||
      report.platforms?.[platform]?.publisherSignature !== "passed") failures.push(`${platform}: desktop/install/signature acceptance required`);
  }
  return { passed: failures.length === 0, failures };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv.find(arg => arg.startsWith("--evidence="))?.slice(11);
  if (!file) throw Error("Provide --evidence=<acceptance.json>");
  const report = await checkReleaseGate(file);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
