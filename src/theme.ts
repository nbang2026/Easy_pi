export type ThemePreference = "system" | "light" | "dark";

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): "light" | "dark" {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function setupThemePreference(root: HTMLElement, windowRef: Window = window) {
  let storage: Storage | null = null;
  try {
    storage = windowRef.localStorage;
  } catch {
    // Storage can be unavailable in restricted webviews.
  }

  let preference: ThemePreference = "system";
  try {
    preference = normalizeThemePreference(storage?.getItem("pi.theme"));
  } catch {
    // Keep the system default when preferences cannot be read.
  }

  let media: MediaQueryList | null = null;
  try {
    media = windowRef.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  } catch {
    // Older or restricted webviews may not expose matchMedia.
  }

  const update = () => {
    const theme = resolveTheme(preference, media?.matches ?? false);
    root.dataset.themePreference = preference;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    root.ownerDocument.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
      "content",
      theme === "dark" ? "#141719" : "#f7f8fa",
    );
  };
  const onSystemThemeChange = () => {
    if (preference === "system") update();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== "pi.theme") return;
    preference = normalizeThemePreference(event.newValue);
    update();
  };
  update();

  if (media?.addEventListener) media.addEventListener("change", onSystemThemeChange);
  else media?.addListener?.(onSystemThemeChange);
  windowRef.addEventListener("storage", onStorage);

  return {
    get preference() {
      return preference;
    },
    setPreference(value: unknown) {
      preference = normalizeThemePreference(value);
      try {
        storage?.setItem("pi.theme", preference);
      } catch {
        // The in-memory choice still applies if persistence is unavailable.
      }
      update();
      return preference;
    },
    dispose() {
      if (media?.removeEventListener) media.removeEventListener("change", onSystemThemeChange);
      else media?.removeListener?.(onSystemThemeChange);
      windowRef.removeEventListener("storage", onStorage);
    },
  };
}
