export type ResumeTarget = { cwd: string; session: string; updatedAt: number };
export const RESUME_KEY = "pi.sessionRecovery.v1";
const path = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 &&
  !/[\0\r\n]/.test(value) && (/^\//.test(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value));

export function readResumeTargets(raw: string | null): ResumeTarget[] {
  if (!raw) return [];
  const data = JSON.parse(raw);
  if (data?.version !== 1 || !Array.isArray(data.targets) || data.targets.length > 12) throw Error("会话恢复索引损坏；原会话文件未受影响，可从会话列表打开。");
  return data.targets.map((row: ResumeTarget) => {
    if (!row || !path(row.cwd) || !path(row.session) || !row.session.endsWith(".jsonl") ||
      !Number.isFinite(row.updatedAt) || row.updatedAt < 0) throw Error("会话恢复索引无效；请从会话列表打开。");
    return { cwd: row.cwd, session: row.session, updatedAt: row.updatedAt };
  });
}
export function storeResumeTarget(previous: ResumeTarget[], target: ResumeTarget): string {
  const targets = [target, ...previous.filter(row => row.cwd !== target.cwd)].slice(0, 12)
    .map(({ cwd, session, updatedAt }) => ({ cwd, session, updatedAt }));
  const result = JSON.stringify({ version: 1, targets });
  readResumeTargets(result);
  return result;
}
