import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReleaseGate } from "./release-gate.mjs";
test("formal release refuses pending acceptance, missing files and incomplete platform signing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-release-gate-")), file = join(root, "acceptance.json");
  try {
    const value = JSON.parse(await readFile(new URL("../release-acceptance.template.json", import.meta.url), "utf8"));
    await writeFile(file, JSON.stringify(value));
    assert.equal((await checkReleaseGate(file)).passed, false);
    await writeFile(join(root, "evidence.txt"), "validated");
    for (const section of Object.values(value.criteria)) { section.status = "passed"; section.evidence = ["evidence.txt"]; }
    for (const platform of Object.values(value.platforms)) for (const key of Object.keys(platform)) platform[key] = "passed";
    await writeFile(file, JSON.stringify(value)); assert.equal((await checkReleaseGate(file)).passed, true);
    value.criteria.security.evidence = ["../outside.txt"];
    await writeFile(file, JSON.stringify(value)); assert.equal((await checkReleaseGate(file)).passed, false);
    value.criteria.security.evidence = ["evidence.txt"]; value.platforms.Windows.publisherSignature = "pending";
    await writeFile(file, JSON.stringify(value)); assert.equal((await checkReleaseGate(file)).passed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
