import { icon } from "./icons.ts";
import type { WallpaperInk } from "./wallpaper-appearance.ts";

export const WALLPAPER_PRESETS = [
  { id: "original", video: "/wallpaper.mp4", poster: "/wallpaper-poster.jpg", ink: "dark" },
  ...["jade", "rose", "pearl", "cobalt", "forest"].map((id) => ({
    id, video: `/wallpapers/${id}.mp4`, poster: `/wallpapers/${id}.jpg`, ink: id === "pearl" ? "dark" : "light",
  })),
] as const;
export const DEFAULT_WALLPAPER_ID = "jade";
export type WallpaperPreset = typeof WALLPAPER_PRESETS[number];

export function wallpaperPreset(id: unknown): WallpaperPreset | undefined {
  return WALLPAPER_PRESETS.find((preset) => preset.id === id);
}

export function setupWallpaperPresets(options: {
  container: HTMLElement;
  translate(key: string): string;
  onSelect(preset: WallpaperPreset): void;
}) {
  let selected = DEFAULT_WALLPAPER_ID;
  const buttons = WALLPAPER_PRESETS.map((preset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wallpaper-preset";
    button.dataset.wallpaperPreset = preset.id;
    const image = document.createElement("img");
    image.src = preset.poster;
    image.alt = "";
    image.loading = "lazy";
    image.width = 320; image.height = 180;
    const label = document.createElement("span");
    const check = icon("check");
    check.classList.add("wallpaper-preset-check");
    button.append(image, label, check);
    button.addEventListener("click", () => options.onSelect(preset));
    options.container.append(button);
    return { button, label, preset };
  });
  const render = () => {
    options.container.setAttribute("aria-label", options.translate("wallpaper.defaults"));
    for (const { button, label, preset } of buttons) {
      label.textContent = options.translate(`wallpaper.${preset.id}`);
      button.title = label.textContent;
      button.setAttribute("aria-label", label.textContent);
      button.setAttribute("aria-pressed", String(selected === preset.id));
    }
  };
  render();
  return {
    select(id: string) { selected = id; render(); },
    refreshLanguage: render,
  };
}

export function presetInk(preset: WallpaperPreset): WallpaperInk {
  return preset.ink === "light" ? "light" : "dark";
}
