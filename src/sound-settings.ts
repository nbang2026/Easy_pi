import { createSoundPackStore, MAX_SOUND_PACKS, readSoundPack, SoundError, type SoundPack } from "./sound-packs.ts";
import { canScrollTarget, createSoundPlayer, DEFAULT_SOUND, isNativeTypingKey, isTypingInput, soundForTarget, soundPreferences, type BuiltinSound } from "./ui-sounds.ts";

export function setupSoundSettings(options: {
  translate(key: string): string;
  store?: ReturnType<typeof createSoundPackStore>;
  player?: ReturnType<typeof createSoundPlayer>;
  readPack?: typeof readSoundPack;
  terminalCanScroll?: (deltaY: number) => boolean;
}) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const toggle = el<HTMLInputElement>("sound-switch");
  const typingToggle = el<HTMLInputElement>("sound-typing-switch");
  const scrollToggle = el<HTMLInputElement>("sound-scroll-switch");
  const volume = el<HTMLInputElement>("sound-volume");
  const output = el<HTMLOutputElement>("sound-volume-value");
  const select = el<HTMLSelectElement>("sound-pack");
  const picker = el<HTMLInputElement>("sound-file");
  const importButton = el<HTMLButtonElement>("sound-import");
  const preview = el<HTMLButtonElement>("sound-preview");
  const remove = el<HTMLButtonElement>("sound-remove");
  const reset = el<HTMLButtonElement>("sound-reset");
  const status = el("sound-status");
  const player = options.player || createSoundPlayer({ onError: (error) => errorMessage(error) });
  const store = options.store || createSoundPackStore();
  const preferences = soundPreferences(localStorage);
  let packs: SoundPack[] = [];
  let loading = true;
  let disposed = false;
  let generation = 0;
  let statusKey = "";
  player.setEnabled(preferences.enabled);
  player.setVolume(preferences.volume);
  player.setEventEnabled("typing", preferences.typing);
  player.setEventEnabled("scroll", preferences.scroll);
  const persist = () => {
    try {
      localStorage.setItem("pi.soundEnabled", preferences.enabled ? "1" : "0");
      localStorage.setItem("pi.soundVolume", String(preferences.volume));
      localStorage.setItem("pi.soundPack", preferences.packId);
      localStorage.setItem("pi.soundTyping", preferences.typing ? "1" : "0");
      localStorage.setItem("pi.soundScroll", preferences.scroll ? "1" : "0");
    } catch { /* Audio remains usable if preference storage is unavailable. */ }
  };
  const message = (key: string) => {
    statusKey = key;
    status.textContent = key ? options.translate(`sound.${key}`) : "";
  };
  const errorMessage = (error: unknown) => {
    if (!disposed) message(error instanceof SoundError ? error.code : "invalidPack");
  };
  const render = () => {
    select.replaceChildren();
    for (const [id, name] of [
      ["builtin-soft", options.translate("sound.soft")],
      ["builtin-crisp", options.translate("sound.crisp")],
      ...packs.map((pack) => [pack.id, pack.name]),
    ]) {
      const item = document.createElement("option");
      item.value = id; item.textContent = name; select.append(item);
    }
    select.value = preferences.packId;
    toggle.checked = preferences.enabled;
    typingToggle.checked = preferences.typing;
    scrollToggle.checked = preferences.scroll;
    typingToggle.disabled = scrollToggle.disabled = !preferences.enabled;
    volume.value = String(preferences.volume);
    output.value = `${preferences.volume}%`;
    preview.disabled = loading || !preferences.enabled || !preferences.volume;
    remove.disabled = loading || !preferences.packId.startsWith("custom-");
    importButton.disabled = select.disabled = reset.disabled = loading;
    if (statusKey) status.textContent = options.translate(`sound.${statusKey}`);
  };
  const applyPack = async (id: string) => {
    if (id === "builtin-soft" || id === "builtin-crisp") player.useBuiltin(id);
    else {
      const pack = packs.find((pack) => pack.id === id);
      if (!pack) throw new SoundError("invalidPack");
      const decoded = await player.prepare(pack);
      if (disposed) return;
      player.usePrepared(decoded);
    }
    preferences.packId = id;
    persist();
  };
  const click = (event: MouseEvent) => {
    if (!event.isTrusted || document.hidden || disposed) return;
    const action = soundForTarget(event.target);
    if (action) void player.play(action);
  };
  document.addEventListener("click", click, true);
  const audible = () => !disposed && !document.hidden && !document.body.dataset.keyRecording && preferences.enabled && preferences.volume > 0;
  const typing = (event: Event) => {
    if (event.isTrusted && audible() && preferences.typing && isTypingInput(event as InputEvent)) void player.play("typing");
  };
  const nativeKey = (event: KeyboardEvent) => {
    if (event.isTrusted && audible() && preferences.typing && isNativeTypingKey(event)) void player.play("typing");
  };
  let lastWheelCheck = -Infinity;
  const wheel = (event: WheelEvent) => {
    if (!event.isTrusted || !audible() || !preferences.scroll || event.ctrlKey || (!event.deltaX && !event.deltaY)) return;
    const now = performance.now();
    if (now - lastWheelCheck < 110) return;
    lastWheelCheck = now;
    if (canScrollTarget(event.target, event.deltaX, event.deltaY, options.terminalCanScroll)) void player.play("scroll");
  };
  document.addEventListener("beforeinput", typing, true);
  document.addEventListener("keydown", nativeKey, true);
  document.addEventListener("wheel", wheel, { capture: true, passive: true });
  for (const [control, key, event] of [[typingToggle, "typing", "typing"], [scrollToggle, "scroll", "scroll"]] as const) {
    control.addEventListener("change", () => {
      preferences[key] = control.checked;
      player.setEventEnabled(event, control.checked);
      persist();
    });
  }
  toggle.addEventListener("change", () => {
    preferences.enabled = toggle.checked;
    player.setEnabled(preferences.enabled);
    persist(); render();
    if (preferences.enabled) void player.play("toggle");
  });
  volume.addEventListener("input", () => {
    preferences.volume = Math.max(0, Math.min(100, Number(volume.value)));
    player.setVolume(preferences.volume);
    persist(); render();
  });
  volume.addEventListener("change", () => { void player.play("toggle"); });
  preview.addEventListener("click", () => { if (!preview.disabled) void player.play("click"); });
  select.addEventListener("change", () => {
    const id = select.value;
    loading = true; message("loading"); render();
    void applyPack(id).then(() => { if (!disposed) { message(""); void player.play("toggle"); } })
      .catch(errorMessage).finally(() => { if (!disposed) { loading = false; render(); } });
  });
  importButton.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file || loading || disposed) return;
    loading = true; message("loading"); render();
    const version = generation;
    void (async () => {
      if (packs.length >= MAX_SOUND_PACKS) throw new SoundError("tooMany");
      const pack = await (options.readPack || readSoundPack)(file);
      const decoded = await player.prepare(pack);
      if (disposed || version !== generation) return;
      await store.save(pack);
      if (disposed || version !== generation) return;
      packs.push(pack);
      player.usePrepared(decoded);
      preferences.packId = pack.id;
      persist(); message("imported");
      void player.play("toggle");
    })().catch(errorMessage).finally(() => { if (!disposed) { loading = false; render(); } });
  });
  remove.addEventListener("click", () => {
    if (remove.disabled) return;
    const id = preferences.packId;
    loading = true; render();
    void store.remove(id).then(() => {
      if (disposed) return;
      packs = packs.filter((pack) => pack.id !== id);
      player.useBuiltin(DEFAULT_SOUND);
      preferences.packId = DEFAULT_SOUND;
      persist(); message("removed");
    }).catch(errorMessage).finally(() => { if (!disposed) { loading = false; render(); } });
  });
  reset.addEventListener("click", () => {
    if (loading) return;
    player.useBuiltin(DEFAULT_SOUND);
    preferences.packId = DEFAULT_SOUND;
    persist(); message(""); render();
  });
  render();
  const ready = store.list().then(async (values) => {
    if (disposed) return;
    packs = values.slice(0, MAX_SOUND_PACKS);
    if (packs.some((pack) => pack.id === preferences.packId)) {
      try { await applyPack(preferences.packId); }
      catch (error) {
        player.useBuiltin(DEFAULT_SOUND);
        preferences.packId = DEFAULT_SOUND;
        persist(); errorMessage(error);
      }
    } else {
      if (preferences.packId.startsWith("custom-")) { preferences.packId = DEFAULT_SOUND; persist(); }
      player.useBuiltin(preferences.packId as BuiltinSound);
    }
  }).catch((error) => {
    if (disposed) return;
    player.useBuiltin(DEFAULT_SOUND);
    preferences.packId = DEFAULT_SOUND;
    errorMessage(error);
  }).finally(() => { if (!disposed) { loading = false; render(); } });
  return {
    ready,
    refreshLanguage: render,
    dispose() {
      disposed = true; generation++;
      document.removeEventListener("click", click, true);
      document.removeEventListener("beforeinput", typing, true);
      document.removeEventListener("keydown", nativeKey, true);
      document.removeEventListener("wheel", wheel, true);
      player.dispose();
    },
  };
}
