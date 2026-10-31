export type ComposerParticleEffect = "off" | "rainbow" | "fireworks" | "starlight" | "bubbles" | "comet" | "pulse";

export function normalizeComposerParticleEffect(value: unknown): ComposerParticleEffect {
  return value === "rainbow" || value === "fireworks" || value === "starlight"
    || value === "bubbles" || value === "comet" || value === "pulse" ? value : "off";
}

export function setupComposerParticles(options: {
  input: HTMLTextAreaElement;
  host: HTMLElement;
  initialEffect?: unknown;
  windowRef?: Window;
  now?: () => number;
}) {
  const input = options.input;
  const host = options.host;
  const layer = host.querySelector<HTMLElement>("#composer-particles");
  const windowRef = options.windowRef ?? input.ownerDocument.defaultView ?? window;
  const doc = input.ownerDocument;
  let effect = normalizeComposerParticleEffect(options.initialEffect);
  let composing = false;
  let disposed = false;
  let lastEmitAt = -Infinity;
  const now = options.now ?? (() => Date.now());
  const timers = new Set<number>();
  const media = windowRef.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;

  const reducedMotion = () => media?.matches ?? false;
  const syncMotionPreference = () => layer?.setAttribute("data-motion", reducedMotion() ? "reduced" : "full");
  const getCaretPoint = () => {
    if (!layer) return { x: host.clientWidth / 2, y: host.clientHeight / 2 };
    const inputRect = input.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const style = windowRef.getComputedStyle(input);
    const mirror = doc.createElement("div");
    Object.assign(mirror.style, {
      position: "fixed",
      left: `${inputRect.left}px`,
      top: `${inputRect.top}px`,
      width: `${input.clientWidth || inputRect.width}px`,
      height: `${input.clientHeight || inputRect.height}px`,
      boxSizing: style.boxSizing,
      padding: style.padding,
      border: style.border,
      font: style.font,
      letterSpacing: style.letterSpacing,
      lineHeight: style.lineHeight,
      textAlign: style.textAlign,
      textIndent: style.textIndent,
      textTransform: style.textTransform,
      whiteSpace: "pre-wrap",
      overflowWrap: style.overflowWrap || "break-word",
      wordBreak: style.wordBreak,
      tabSize: style.tabSize,
      overflow: "hidden",
      margin: "0",
      visibility: "hidden",
      pointerEvents: "none",
      contain: "layout style",
    });
    mirror.setAttribute("aria-hidden", "true");
    const cursor = Math.max(0, input.selectionStart ?? input.value.length);
    mirror.append(doc.createTextNode(input.value.slice(0, cursor)));
    const marker = doc.createElement("span");
    marker.textContent = input.value.slice(cursor, cursor + 1) || "\u200b";
    Object.assign(marker.style, {
      display: "inline-block",
      width: "1px",
      height: `${Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.6 || 22}px`,
      verticalAlign: "text-bottom",
    });
    mirror.append(marker, doc.createTextNode(input.value.slice(cursor + 1)));
    doc.body.append(mirror);
    const rect = marker.getBoundingClientRect();
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.6 || 22;
    const x = rect.width || rect.height
      ? rect.left - hostRect.left - input.scrollLeft
      : Math.min(Math.max(12, inputRect.width * 0.55), Math.max(12, inputRect.width - 12));
    const y = rect.width || rect.height
      ? rect.top - hostRect.top - input.scrollTop + (rect.height || lineHeight) / 2
      : Math.min(Math.max(16, inputRect.height / 2), Math.max(16, inputRect.height - 8));
    mirror.remove();
    return { x, y };
  };
  const removeParticle = (particle: HTMLElement, timer?: number) => {
    if (timer !== undefined) {
      windowRef.clearTimeout(timer);
      timers.delete(timer);
    }
    particle.remove();
  };
  const emit = () => {
    if (disposed || !layer || effect === "off" || reducedMotion() || !input.isConnected) return;
    const timestamp = now();
    if (timestamp - lastEmitAt < 36) return;
    lastEmitAt = timestamp;
    if (input.dataset.particleSuppressed === "true") return;
    const point = getCaretPoint();
    const count = effect === "fireworks" ? 12 : effect === "starlight" || effect === "pulse" ? 6 : 9;
    const palette = effect === "fireworks"
      ? ["#ffb347", "#ff705f", "#c18bff", "#fff18a"]
      : effect === "starlight" ? ["#fff8cc", "#b9f6ff", "#ffffff"]
        : effect === "bubbles" ? ["#89e4d0", "#9ad8ff", "#d9b6ff"]
          : effect === "comet" ? ["#fff1a8", "#9fe8ff", "#ffffff"]
            : effect === "pulse" ? ["#77e0b2", "#9ce6d3", "#ffffff"] : [];
    if (layer.childElementCount + count > 42) return;
    for (let index = 0; index < count; index++) {
      const particle = doc.createElement("span");
      particle.className = `composer-particle composer-particle-${effect}`;
      particle.style.left = `${point.x}px`;
      particle.style.top = `${point.y}px`;
      if (effect === "rainbow") {
        const hue = Math.round((index / count * 360 + Math.random() * 18) % 360);
        particle.style.backgroundColor = `hsl(${hue} 92% 64%)`;
        particle.style.color = `hsl(${hue} 92% 64%)`;
      } else {
        const color = palette[index % palette.length];
        particle.style.backgroundColor = color;
        particle.style.color = color;
      }
      const angle = effect === "fireworks"
        ? Math.PI * 2 * index / count + Math.random() * 0.22
        : effect === "comet" ? Math.PI * (0.15 + Math.random() * 0.2) : Math.PI * 2 * Math.random();
      const distance = effect === "fireworks" ? 20 + Math.random() * 13
        : effect === "bubbles" ? 18 + Math.random() * 20
          : effect === "comet" ? 24 + Math.random() * 18 : 13 + Math.random() * 19;
      particle.style.setProperty("--particle-x", `${Math.cos(angle) * distance}px`);
      particle.style.setProperty("--particle-y", `${Math.sin(angle) * distance - (effect === "rainbow" || effect === "bubbles" || effect === "comet" ? 7 : 0)}px`);
      layer.append(particle);
      const timer = windowRef.setTimeout(() => removeParticle(particle, timer), 950);
      timers.add(timer);
      particle.addEventListener("animationend", () => removeParticle(particle, timer), { once: true });
    }
  };
  const onInput = (event: Event) => {
    if (input.dataset.particleSuppressed === "true" || composing || (event as InputEvent).isComposing) return;
    emit();
  };
  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => { composing = false; emit(); };
  const onKeyup = (event: KeyboardEvent) => {
    if (event.isComposing || composing || event.ctrlKey || event.metaKey || event.altKey
      || !(event.key.length === 1 || event.key === "Backspace" || event.key === "Delete")) return;
    emit();
  };
  const onSelect = () => { if (!composing) emit(); };
  const onMotionChange = () => syncMotionPreference();

  syncMotionPreference();
  input.addEventListener("input", onInput);
  input.addEventListener("keyup", onKeyup);
  input.addEventListener("select", onSelect);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);
  if (media?.addEventListener) media.addEventListener("change", onMotionChange);
  else media?.addListener?.(onMotionChange);

  return {
    setEffect(value: unknown) {
      effect = normalizeComposerParticleEffect(value);
      lastEmitAt = -Infinity;
      for (const timer of timers) windowRef.clearTimeout(timer);
      timers.clear();
      layer?.replaceChildren();
    },
    dispose() {
      disposed = true;
      input.removeEventListener("input", onInput);
      input.removeEventListener("keyup", onKeyup);
      input.removeEventListener("select", onSelect);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
      if (media?.removeEventListener) media.removeEventListener("change", onMotionChange);
      else media?.removeListener?.(onMotionChange);
      for (const timer of timers) windowRef.clearTimeout(timer);
      timers.clear();
      layer?.replaceChildren();
    },
  };
}
