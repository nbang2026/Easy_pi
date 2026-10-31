export type ReleaseArtifact = { name: string; platform: "macOS" | "Windows"; arch: "arm64" | "x64"; bytes: number; sha256: string };
export type ReleaseManifest = { schema: 1; product: "easy_pi"; version: string; publishedAt: string; artifacts: ReleaseArtifact[] };
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9a-z.-]+))?$/i;
export function compareVersions(left: string, right: string): number {
  const a = left.match(versionPattern), b = right.match(versionPattern);
  if (!a || !b || left.length > 64 || right.length > 64) throw Error("无效的版本号");
  for (let i = 1; i <= 3; i++) {
    if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]) ? 1 : -1;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const aa = a[4].split("."), bb = b[4].split(".");
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined || bb[i] === undefined) return aa[i] === bb[i] ? 0 : aa[i] === undefined ? -1 : 1;
    if (aa[i] === bb[i]) continue;
    const an = /^\d+$/.test(aa[i]), bn = /^\d+$/.test(bb[i]);
    if (an && bn) return BigInt(aa[i]) > BigInt(bb[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return aa[i] > bb[i] ? 1 : -1;
  }
  return 0;
}
export function parseReleaseManifest(raw: string): ReleaseManifest {
  if (raw.length > 65536) throw Error("版本清单过大");
  const value = JSON.parse(raw);
  if (value?.schema !== 1 || value.product !== "easy_pi" || typeof value.version !== "string" ||
    value.version.length > 64 || !versionPattern.test(value.version) || typeof value.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(value.publishedAt)) || !Array.isArray(value.artifacts) ||
    !value.artifacts.length || value.artifacts.length > 20) throw Error("版本清单格式无效");
  const names = new Set<string>();
  const artifacts = value.artifacts.map((item: ReleaseArtifact) => {
    if (!item || typeof item.name !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,180}\.(zip|dmg|exe|msi)$/i.test(item.name) ||
      !["macOS", "Windows"].includes(item.platform) || !["arm64", "x64"].includes(item.arch) ||
      !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256) ||
      names.has(item.name)) throw Error("版本文件信息无效");
    names.add(item.name);
    return { name: item.name, platform: item.platform, arch: item.arch, bytes: item.bytes, sha256: item.sha256.toLowerCase() };
  });
  return { schema: 1, product: "easy_pi", version: value.version, publishedAt: value.publishedAt, artifacts };
}
