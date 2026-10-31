import type { ITheme } from "@xterm/xterm";
import { clampNumber } from "./utils.ts";

export type WallpaperInk = "light" | "dark";
export const CUSTOM_FONT_FAMILY = "PiImportedFont";
export const MAX_CUSTOM_FONT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TERMINAL_FONT_FAMILY = '"SFMono-Regular", Menlo, Monaco, "PingFang SC", "Microsoft YaHei", monospace';

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value)) return null;
  return value.toLowerCase();
}

export function isSupportedFontFile(name: unknown, size: unknown, header: Uint8Array): boolean {
  if (typeof name !== "string" || typeof size !== "number" || size <= 0 || size > MAX_CUSTOM_FONT_BYTES || header.length < 4) return false;
  const extension = name.split(".").pop()?.toLowerCase();
  const signature = String.fromCharCode(...header.slice(0, 4));
  const expected = extension === "ttf" ? ["\u0000\u0001\u0000\u0000", "true", "typ1"]
    : extension === "otf" ? ["OTTO"]
      : extension === "woff" ? ["wOFF"]
        : extension === "woff2" ? ["wOF2"] : [];
  return expected.includes(signature);
}

export function normalizeWallpaperInk(value: unknown): WallpaperInk {
  return value === "light" ? "light" : "dark";
}

export function wallpaperFontSize(value: unknown): number {
  return Math.round(clampNumber(value, 12, 28, 16));
}

export function wallpaperUiSize(value: unknown): number {
  return Math.round(clampNumber(value, 12, 18, 14));
}

export function wallpaperTheme(ink: WallpaperInk, base: ITheme, customColor?: unknown): ITheme {
  const dark = ink === "dark";
  const foreground = normalizeHexColor(customColor) || (dark ? "#172421" : "#ffffff");
  return {
    ...base,
    // The RGB channels also give xterm a contrast reference; alpha stays zero.
    background: dark ? "rgba(255, 255, 255, 0)" : "rgba(0, 0, 0, 0)",
    foreground,
    brightWhite: foreground,
    cursor: dark ? "#126b59" : "#ffffff",
    cursorAccent: dark ? "#ffffff" : "#172421",
    selectionBackground: dark ? "#197c6840" : "#ffffff45",
    selectionInactiveBackground: dark ? "#197c6825" : "#ffffff25",
  };
}
