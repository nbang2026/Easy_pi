export type PiConnectionStatus = { connected?: boolean; ready?: boolean; processAlive?: boolean; busy?: boolean; bridgeId?: string; exitCode?: number; startupElapsedSeconds?: number; startupError?: string };
export function createPiRecovery(options: {
  probe(): Promise<PiConnectionStatus>;
  stop(): Promise<void>;
  start(): Promise<void>;
  invalidate(): void;
  confirm(): Promise<boolean>;
  stalled(error: unknown): void;
  recovered?(status: PiConnectionStatus): void;
  pollMs?: number;
  timeoutMs?: number;
  graceMs?: number;
}) {
  let disposed = false, restarting = false, paused = false;
  let polling: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lostAt = 0, hasConnected = false, generation = 0;
  const cancels = new Set<() => void>();
  const bounded = <T>(request: Promise<T>) => new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timeout); cancels.delete(cancel); action(); };
    const cancel = () => finish(() => reject(Error("Pi 状态查询已取消。")));
    const timeout = setTimeout(() => finish(() => reject(Error("Pi 状态查询超时，可重启当前窗口的 Pi 恢复。"))), options.timeoutMs ?? 3500);
    cancels.add(cancel);
    request.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
  const cancelProbes = () => { for (const cancel of [...cancels]) cancel(); };
  const pause = () => {
    paused = true; generation++; clearTimeout(timer); timer = undefined; cancelProbes();
    lostAt = 0; hasConnected = false;
  };
  const tick = async () => {
    if (disposed || paused || polling === generation || restarting) return;
    const current = generation; polling = current;
    try {
      const value = await bounded(options.probe());
      if (disposed || current !== generation) return;
      if (value.connected) {
        const wasLost = !!lostAt;
        lostAt = 0; hasConnected = true;
        if (wasLost) options.recovered?.(value);
      } else {
        lostAt ||= Date.now();
        if (value.processAlive === false || Date.now() - lostAt >= (options.graceMs ?? (hasConnected ? 4000 : 12000))) {
          options.stalled(Error(value.processAlive === false
            ? `当前窗口的 Pi 已退出${Number.isInteger(value.exitCode) ? `（退出码 ${value.exitCode}）` : ""}。${value.startupError ? `启动错误：${value.startupError}\n` : ""}请查看自动检验和终端错误后重新启动；草稿保留。`
            : `Pi 进程仍在运行，但输入桥接尚未就绪${Number.isFinite(value.startupElapsedSeconds) ? `（已启动 ${value.startupElapsedSeconds} 秒）` : ""}。请查看终端是否等待初始化、辅助工具下载或确认提示；不要重复发送。草稿已保留，可手动重启。`));
        }
      }
    } catch (error) { if (!disposed && current === generation) { lostAt ||= Date.now(); options.stalled(error); } }
    finally {
      if (polling === current) polling = undefined;
      if (!disposed && !paused && current === generation && !restarting && !timer) timer = setTimeout(() => { timer = undefined; void tick(); }, options.pollMs ?? 2000);
    }
  };
  return {
    pause,
    monitor() { if (disposed) return; paused = false; if (!timer && polling !== generation) { lostAt = Date.now(); void tick(); } },
    async restart() {
      if (disposed || restarting) return;
      restarting = true;
      let resume = !paused;
      try {
        if (!(await options.confirm()) || disposed) return;
        pause();
        options.invalidate();
        await options.stop();
        if (disposed) return;
        resume = false;
        await options.start();
        resume = true;
        lostAt = Date.now(); hasConnected = false;
      } catch (error) { if (!disposed) { if (!resume) pause(); options.stalled(error); throw error; } }
      finally { restarting = false; if (!disposed && resume) { paused = false; if (!timer) void tick(); } }
    },
    check: tick,
    busy: () => restarting,
    dispose() { disposed = true; generation++; clearTimeout(timer); timer = undefined; cancelProbes(); },
  };
}
