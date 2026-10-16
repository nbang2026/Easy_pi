type Disposable = { dispose(): void };
type Renderer = Disposable & { onContextLoss(callback: () => void): Disposable };

export function createRendererController<R extends Renderer>(
  load: (renderer: R) => void,
  create: () => R,
  onChange: (accelerated: boolean) => void,
) {
  let active: R | undefined;
  let loss: Disposable | undefined;

  const dispose = () => {
    loss?.dispose();
    loss = undefined;
    const old = active;
    active = undefined;
    old?.dispose();
    onChange(false);
  };

  return {
    setEnabled(enabled: boolean) {
      if (!enabled) { dispose(); return; }
      if (active) return;
      try {
        active = create();
        loss = active.onContextLoss(dispose);
        load(active);
        if (active) onChange(true);
      } catch {
        // Unsupported/lost graphics contexts fall back to xterm's DOM renderer.
        dispose();
      }
    },
    dispose,
  };
}
