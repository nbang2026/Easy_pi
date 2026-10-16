import type { ITheme } from "@xterm/xterm";
import { clampNumber } from "./utils.ts";

export type WallpaperInk = "light" | "dark";

export function normalizeWallpaperInk(value: unknown): WallpaperInk {
  return value === "light" ? "light" : "dark";
}

export function wallpaperFontSize(value: unknown): number {
  return Math.round(clampNumber(value, 12, 28, 16));
}

export function wallpaperUiSize(value: unknown): number {
  return Math.round(clampNumber(value, 12, 18, 14));
}

export function wallpaperTheme(ink: WallpaperInk, base: ITheme): ITheme {
  const dark = ink === "dark";
  return {
    ...base,
    // The RGB channels also give xterm a contrast reference; alpha stays zero.
    background: dark ? "rgba(255, 255, 255, 0)" : "rgba(0, 0, 0, 0)",
    foreground: dark ? "#172421" : "#ffffff",
    brightWhite: dark ? "#172421" : "#ffffff",
    cursor: dark ? "#126b59" : "#ffffff",
    cursorAccent: dark ? "#ffffff" : "#172421",
    selectionBackground: dark ? "#197c6840" : "#ffffff45",
    selectionInactiveBackground: dark ? "#197c6825" : "#ffffff25",
  };
}
