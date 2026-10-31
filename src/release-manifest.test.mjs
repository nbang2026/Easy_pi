import test from "node:test";
import assert from "node:assert/strict";
import { parseReleaseManifest, compareVersions } from "./release-manifest.ts";
const fixture = () => ({ schema: 1, product: "easy_pi", version: "1.0.11", publishedAt: "2026-10-17T12:00:00Z",
  artifacts: [{ name: "easy_pi-macOS.zip", platform: "macOS", arch: "arm64", bytes: 100, sha256: "a".repeat(64) }] });
test("version checks compare numeric components and prerelease identifiers", () => {
  assert.equal(compareVersions("1.0.11", "1.0.10-fix.1"), 1);
  assert.equal(compareVersions("1.0.10-fix.2", "1.0.10-fix.10"), -1);
  assert.equal(compareVersions("1.0.10", "1.0.10-fix.1"), 1);
  assert.equal(compareVersions("1.0.10-fix.1", "1.0.10-fix.1"), 0);
  assert.throws(() => compareVersions("invalid", "1.0.0"));
});
test("release manifests reject invalid hashes, duplicate files, paths and mismatched product identities", () => {
  assert.equal(parseReleaseManifest(JSON.stringify(fixture())).artifacts.length, 1);
  for (const mutate of [
    x => x.product = "other", x => x.artifacts[0].name = "../bad.zip",
    x => x.artifacts[0].sha256 = "unknown", x => x.artifacts[0].platform = "Linux",
    x => x.artifacts.push(x.artifacts[0]), x => x.artifacts[0].bytes = -1,
  ]) { const data = fixture(); mutate(data); assert.throws(() => parseReleaseManifest(JSON.stringify(data))); }
});
