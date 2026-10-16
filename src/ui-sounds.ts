import { SOUND_EVENTS, SoundError, type SoundClip, type SoundEvent, type SoundPack } from "./sound-packs.ts";

export type BuiltinSound = "builtin-soft" | "builtin-crisp";
export type SoundPreferences = { enabled: boolean; typing: boolean; scroll: boolean; volume: number; packId: string };
export const DEFAULT_SOUND: BuiltinSound = "builtin-soft";

export function soundPreferences(storage: Pick<Storage, "getItem">): SoundPreferences {
  const read = (key: string) => { try { return storage.getItem(key); } catch { return null; } };
  const rawVolume = read("pi.soundVolume");
  const volume = rawVolume === null || !Number.isFinite(Number(rawVolume)) ? 25 : Math.max(0, Math.min(100, Number(rawVolume)));
  const id = read("pi.soundPack") || DEFAULT_SOUND;
  return { enabled: read("pi.soundEnabled") !== "0", typing: read("pi.soundTyping") !== "0",
    scroll: read("pi.soundScroll") !== "0", volume,
    packId: /^builtin-(soft|crisp)$|^custom-[a-z0-9-]{10,64}$/i.test(id) ? id : DEFAULT_SOUND };
}

export function soundForTarget(target: EventTarget | null): SoundEvent | undefined {
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>("button, summary, input[type=checkbox], input[type=radio], select, [role=button]");
  if (!control || control.matches(":disabled, [aria-disabled=true], [data-sound=none]")
    || control.closest("[hidden], [inert]") || control.closest("#terminal")) return;
  const explicit = control.dataset.sound;
  if (explicit && SOUND_EVENTS.includes(explicit as SoundEvent)) return explicit as SoundEvent;
  if (control.matches("input, select, [aria-pressed], [role=menuitemcheckbox]")) return "toggle";
  if (/close|cancel|stop/.test(control.id)) return "close";
  if (control.matches("summary, [aria-haspopup], [role=tab]") || /open|toggle/.test(control.id)) return "open";
  return "click";
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target.closest("[hidden], [inert], [data-sound=none]")) return false;
  const field = target.closest("textarea, input, [contenteditable=true]");
  return !!field && !field.matches(":disabled, [readonly], input[type=password], input[type=file], input[type=range], input[type=checkbox], input[type=radio], input[type=button], input[type=submit], input[type=number]");
}

export function isTypingInput(event: InputEvent): boolean {
  return isTypingTarget(event.target)
    && /^(insertText|insertCompositionText|insertFromComposition|insertLineBreak|insertParagraph|deleteContentBackward|deleteContentForward)$/.test(event.inputType);
}

export function isNativeTypingKey(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing
    && isTypingTarget(event.target) && !!(event.target as Element).closest("#terminal")
    && (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete");
}

export function canScrollTarget(target: EventTarget | null, deltaX: number, deltaY: number,
  terminalCanScroll?: (deltaY: number) => boolean): boolean {
  if (!(target instanceof Element) || target.closest("[hidden], [inert]")) return false;
  if (target.closest("#terminal") && deltaY && terminalCanScroll?.(deltaY)) return true;
  for (let node: Element | null = target; node; node = node.parentElement) {
    const horizontal = deltaX && (deltaX < 0 ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
    const vertical = deltaY && (deltaY < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1);
    if (!horizontal && !vertical) continue;
    const style = node.ownerDocument.defaultView!.getComputedStyle(node);
    if ((horizontal && /auto|scroll/.test(style.overflowX))
      || (vertical && /auto|scroll/.test(style.overflowY))) return true;
  }
  return false;
}

export function validateSoundBuffer(buffer: AudioBuffer): void {
  if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 3
    || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2 || buffer.sampleRate > 96000) {
    throw new SoundError("invalidAudio");
  }
}

function audioDuration(clip: SoundClip): Promise<void> {
  return new Promise((resolve, reject) => {
    const media = new Audio();
    const extension = clip.filename.split(".").pop()!.toLowerCase();
    const mime: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg" };
    const url = URL.createObjectURL(new Blob([clip.bytes], { type: mime[extension] }));
    const finish = (error?: SoundError) => {
      clearTimeout(timer);
      media.onloadedmetadata = media.onerror = null;
      media.removeAttribute("src");
      media.load();
      URL.revokeObjectURL(url);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new SoundError("invalidAudio")), 8000);
    media.preload = "metadata";
    media.onloadedmetadata = () => finish(!Number.isFinite(media.duration) || media.duration <= 0 || media.duration > 3
      ? new SoundError("invalidAudio") : undefined);
    media.onerror = () => finish(new SoundError("invalidAudio"));
    media.src = url;
  });
}

export function createSoundPlayer(options: {
  createContext?: () => AudioContext;
  validateDuration?: (clip: SoundClip) => Promise<void>;
  now?: () => number;
  onError?: (error: unknown) => void;
} = {}) {
  let context: AudioContext | undefined;
  let master: GainNode | undefined;
  let enabled = true;
  let volume = 25;
  let disposed = false;
  let generation = 0;
  const lastPlay = new Map<string, number>();
  const mutedEvents = new Set<SoundEvent>();
  let buffers: Partial<Record<SoundEvent, AudioBuffer>> = {};
  let builtin: BuiltinSound = DEFAULT_SOUND;
  const builtinCache = new Map<string, AudioBuffer>();
  const voices = new Set<AudioBufferSourceNode>();
  const voiceEvents = new Map<AudioBufferSourceNode, SoundEvent>();
  const now = options.now || (() => performance.now());
  const ensureContext = () => {
    if (disposed) throw new SoundError("audioUnavailable");
    if (!context) {
      try {
        context = options.createContext ? options.createContext() : new AudioContext({ latencyHint: "interactive" });
        master = context.createGain();
        master.gain.value = volume / 100;
        master.connect(context.destination);
      } catch { throw new SoundError("audioUnavailable"); }
    }
    return context;
  };
  const stopVoices = () => {
    for (const source of voices) { try { source.stop(); } catch { /* Already ended. */ } }
    voices.clear();
    voiceEvents.clear();
  };
  const nativeBuffer = (event: SoundEvent) => {
    const audio = ensureContext();
    const key = `${builtin}:${event}`;
    let buffer = builtinCache.get(key);
    if (!buffer) {
      const rate = audio.sampleRate;
      const duration = event === "typing" ? 0.025 : event === "scroll" ? 0.035 : builtin === "builtin-soft" ? 0.065 : 0.038;
      buffer = audio.createBuffer(1, Math.ceil(rate * duration), rate);
      const samples = buffer.getChannelData(0);
      const pitch = { click: 620, toggle: 760, open: 880, close: 460, send: 1040, typing: 310, scroll: 420 }[event];
      for (let i = 0; i < samples.length; i++) {
        const t = i / rate;
        const envelope = Math.min(1, t / 0.002) * Math.exp(-t * (builtin === "builtin-soft" ? 85 : 130));
        samples[i] = envelope * (Math.sin(2 * Math.PI * pitch * t) * 0.45
          + Math.sin(2 * Math.PI * pitch * 2.4 * t) * (builtin === "builtin-soft" ? 0.06 : 0.2));
      }
      builtinCache.set(key, buffer);
    }
    return buffer;
  };
  const play = async (event: SoundEvent = "click") => {
    const group = event === "typing" || event === "scroll" ? event : "controls";
    const interval = event === "scroll" ? 110 : 40;
    if (!enabled || !volume || disposed || mutedEvents.has(event) || now() - (lastPlay.get(group) ?? -Infinity) < interval) return;
    lastPlay.set(group, now());
    const requestedAt = now();
    const version = generation;
    try {
      const audio = ensureContext();
      const buffer = buffers[event] || buffers.click || nativeBuffer(event);
      if (audio.state !== "running") await audio.resume();
      // Drop stale clicks rather than queueing them while the device wakes or a pack changes.
      if (disposed || !enabled || !volume || mutedEvents.has(event) || version !== generation
        || now() - requestedAt > 200 || audio.state !== "running") return;
      if (voices.size >= 2) {
        const oldest = voices.values().next().value!;
        oldest.stop();
        voices.delete(oldest);
        voiceEvents.delete(oldest);
      }
      const source = audio.createBufferSource();
      const fade = audio.createGain();
      source.buffer = buffer;
      const start = audio.currentTime;
      // High-frequency events stay short only when an older pack falls back to its long click;
      // a pack's own typing or scroll clip plays at its authored length.
      const fallback = !buffers[event] && !!buffers.click;
      const limit = fallback && event === "typing" ? 0.07 : fallback && event === "scroll" ? 0.09 : 3;
      const duration = Math.min(buffer.duration, limit);
      const level = event === "typing" ? 0.45 : event === "scroll" ? 0.3 : 1;
      const attack = Math.min(0.002, duration / 4);
      fade.gain.setValueAtTime(0, start);
      fade.gain.linearRampToValueAtTime(level, start + attack);
      fade.gain.setValueAtTime(level, start + Math.max(attack, duration - 0.01));
      fade.gain.linearRampToValueAtTime(0, start + duration);
      source.connect(fade);
      fade.connect(master!);
      source.onended = () => { voices.delete(source); voiceEvents.delete(source); source.disconnect(); fade.disconnect(); };
      voices.add(source);
      voiceEvents.set(source, event);
      source.start(start, 0, duration);
    } catch (error) {
      try { options.onError?.(error instanceof SoundError ? error : new SoundError("audioUnavailable")); }
      catch { /* Audio must never interrupt a button's action. */ }
    }
  };
  return {
    play,
    setEnabled(value: boolean) { enabled = value; generation++; if (!value) stopVoices(); },
    setEventEnabled(event: SoundEvent, value: boolean) {
      if (value) mutedEvents.delete(event);
      else {
        mutedEvents.add(event);
        for (const [source, playing] of voiceEvents) {
          if (playing === event) { try { source.stop(); } catch { /* Already ended. */ } }
        }
      }
    },
    setVolume(value: number) {
      volume = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 25;
      if (master) master.gain.value = volume / 100;
      if (!volume) { generation++; stopVoices(); }
    },
    async prepare(pack: SoundPack) {
      const audio = ensureContext();
      const decoded: Partial<Record<SoundEvent, AudioBuffer>> = {};
      for (const event of SOUND_EVENTS) {
        const clip = pack.sounds[event];
        if (!clip) continue;
        await (options.validateDuration || audioDuration)(clip);
        let buffer: AudioBuffer;
        try { buffer = await audio.decodeAudioData(clip.bytes.slice(0)); }
        catch { throw new SoundError("invalidAudio"); }
        validateSoundBuffer(buffer);
        let peak = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          for (const value of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(value));
        }
        if (!Number.isFinite(peak)) throw new SoundError("invalidAudio");
        if (peak > 0.9) {
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const samples = buffer.getChannelData(channel);
            for (let i = 0; i < samples.length; i++) samples[i] *= 0.9 / peak;
          }
        }
        decoded[event] = buffer;
      }
      if (!decoded.click) throw new SoundError("missingClick");
      return decoded;
    },
    useBuiltin(id: BuiltinSound) { generation++; stopVoices(); builtin = id; buffers = {}; },
    usePrepared(value: Partial<Record<SoundEvent, AudioBuffer>>) { generation++; stopVoices(); buffers = value; },
    dispose() {
      disposed = true; generation++; stopVoices(); buffers = {}; builtinCache.clear();
      void context?.close().catch(() => {});
    },
  };
}
