import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWallpaperInk, wallpaperFontSize, wallpaperUiSize, wallpaperTheme } from "./wallpaper-appearance.ts";

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
