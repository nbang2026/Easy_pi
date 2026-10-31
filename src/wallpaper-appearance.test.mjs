import assert from "node:assert/strict";
import test from "node:test";
import { isSupportedFontFile, MAX_CUSTOM_FONT_BYTES, normalizeHexColor, normalizeWallpaperInk, wallpaperFontSize, wallpaperUiSize, wallpaperTheme } from "./wallpaper-appearance.ts";

test("wallpaper font preferences are independent, bounded and have readable defaults", () => {
  assert.equal(wallpaperFontSize(null), 16);
  assert.equal(wallpaperFontSize("broken"), 16);
  assert.equal(wallpaperFontSize("7"), 12);
  assert.equal(wallpaperFontSize("30"), 28);
  assert.equal(wallpaperFontSize("18.3"), 18);
  assert.equal(wallpaperUiSize(null), 14);
  assert.equal(wallpaperUiSize("30"), 18);
  assert.equal(wallpaperUiSize("-20"), 12);
});
test("dark and light text both retain a fully transparent wallpaper background", () => {
  const base = { background: "#181a1d", red: "#dc8d87", blue: "#8db2d1" };
  for (const ink of ["dark", "light"]) {
    const theme = wallpaperTheme(ink, base);
    assert.match(theme.background, /^rgba\((?:255, 255, 255|0, 0, 0), 0\)$/);
    assert.equal(theme.red, base.red);
    assert.equal(theme.blue, base.blue);
    assert.notEqual(theme.foreground, base.background);
  }
  assert.equal(base.background, "#181a1d");
  assert.equal(wallpaperTheme("dark", base).foreground, "#172421");
  assert.equal(wallpaperTheme("light", base).foreground, "#ffffff");
});
test("unknown color preferences use dark text for the original bright wallpaper", () => {
  assert.equal(normalizeWallpaperInk("light"), "light");
  for (const ink of [null, "", "wrong", "dark"]) assert.equal(normalizeWallpaperInk(ink), "dark");
});
test("custom terminal colors accept only six-digit hex values", () => {
  assert.equal(normalizeHexColor("#A1b2C3"), "#a1b2c3");
  for (const value of [null, "red", "#fff", "#00112244", " #112233", 42]) assert.equal(normalizeHexColor(value), null);
  const base = { foreground: "#dbe0e4", background: "rgba(0, 0, 0, 0)" };
  const theme = wallpaperTheme("light", base, "#4f6a7b");
  assert.equal(theme.foreground, "#4f6a7b");
  assert.equal(theme.brightWhite, "#4f6a7b");
  assert.equal(theme.background, "rgba(0, 0, 0, 0)");
  assert.equal(wallpaperTheme("light", base, "invalid").foreground, "#ffffff");
});
test("font imports require a matching supported signature and stay under the local size cap", () => {
  const header = (signature) => Uint8Array.from([...signature].map((character) => character.charCodeAt(0)));
  for (const [name, signature] of [["A.ttf", "\u0000\u0001\u0000\u0000"], ["B.otf", "OTTO"], ["C.woff", "wOFF"], ["D.woff2", "wOF2"]]) {
    assert.equal(isSupportedFontFile(name, 1024, header(signature)), true);
  }
  assert.equal(isSupportedFontFile("font.woff2", 1024, header("wOFF")), false);
  assert.equal(isSupportedFontFile("font.exe", 1024, header("wOFF")), false);
  assert.equal(isSupportedFontFile("font.ttf", MAX_CUSTOM_FONT_BYTES + 1, header("\u0000\u0001\u0000\u0000")), false);
  assert.equal(isSupportedFontFile("font.ttf", 0, header("\u0000\u0001\u0000\u0000")), false);
});
