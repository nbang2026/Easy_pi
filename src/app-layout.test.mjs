import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("easy_pi branding preserves Pi core storage and internal build identity", () => {
  const config = JSON.parse(read("../src-tauri/tauri.conf.json"));
  const html = read("../index.html");
  assert.equal(config.productName, "easy_pi");
  assert.equal(config.app.windows[0].title, "easy_pi");
  assert.equal(config.identifier, "com.pi.desktop");
  assert.match(html, /<title>easy_pi/);
  assert.match(html, /<h1>easy_pi<\/h1>/);
  assert.match(html, /<span>easy_pi Desktop<\/span>/);
  assert.doesNotMatch(html, /N_B_PI/);
  assert.equal(JSON.parse(read("../package.json")).name, "pi-app");
  assert.match(read("../src-tauri/Cargo.toml"), /name = "pi-app"/);
  assert.match(read("../src-tauri/Cargo.toml"), /name = "pi_app_lib"/);
  assert.match(read("./main.ts"), /const filename = `pi-terminal-/);
  assert.match(read("../src-tauri/src/lib.rs"), /filename\.starts_with\("pi-terminal-"\)/);
});
test("fullscreen and frame controls have native permission and labeled button hooks", () => {
  const { permissions } = JSON.parse(read("../src-tauri/capabilities/default.json"));
  const html = read("../index.html");
  assert.ok(permissions.includes("core:window:allow-set-fullscreen"));
  assert.ok(permissions.includes("core:window:allow-set-decorations"));
  assert.match(html, /id="fullscreen-toggle"[^>]+aria-pressed="false"/);
  assert.match(html, /id="frame-toggle"[^>]+aria-pressed="false"/);
});
test("wallpaper has no full-screen dimmer and collapsing frames retains the restore buttons", () => {
  const html = read("../index.html");
  const css = read("./style.css");
  assert.doesNotMatch(html, /wallpaper-shade/);
  assert.doesNotMatch(css, /wallpaper-shade|--terminal-shade/);
  assert.match(css, /body\.wallpaper-mode \.modal-backdrop\s*\{[^}]*background:\s*transparent;[^}]*backdrop-filter:\s*none;/);
  assert.match(css, /body\.wallpaper-mode #terminal-welcome\s*\{[^}]*background:\s*transparent;/);
  assert.match(css, /\.terminal-tools > :not\(#fullscreen-toggle, #frame-toggle\)/);
});
test("wallpaper uses the original autoplay loop without focus-based pause or manual reload", () => {
  const html = read("../index.html");
  const main = read("./main.ts");
  const css = read("./style.css");
  assert.match(html, /<video[^>]+autoplay muted loop playsinline/);
  assert.doesNotMatch(html, /preload="auto"/);
  assert.doesNotMatch(main, /createWallpaperPlayback|mediaReady|windowFocused|wallpaperVideo\.load\(/);
  assert.doesNotMatch(main, /addEventListener\("(?:focus|blur|visibilitychange)"/);
  assert.match(main, /const playing = wallpaperVideo\.play\(\)/);
  assert.equal((main.match(/wallpaperVideo\.pause\(\)/g) || []).length, 1);
  assert.match(css, /\.no-wallpaper #wallpaper, \.no-wallpaper #wallpaper-image \{ opacity: 0; \}/);
  assert.doesNotMatch(css, /translateZ\(/);
  assert.match(html, /<body>\s*<video id="wallpaper"/);
  assert.match(css, /#wallpaper, #wallpaper-image \{ position: fixed;/);
  assert.match(css, /body\.wallpaper-mode #app-main,\s*body\.wallpaper-mode \.terminal-workspace,\s*body\.wallpaper-mode #terminal-stage \{ background: transparent;/);
  assert.ok(main.indexOf("showCustomWallpaper(file, file.name)") < main.indexOf('idbPut("custom", file)'));
  const reset = main.slice(main.indexOf('wallpaperReset.addEventListener("click"'));
  assert.ok(reset.indexOf("showDefaultWallpaper()") < reset.indexOf('idbDelete("custom")'));
});
test("terminal sizing excludes toolbar space rather than relying on parent padding", () => {
  const css = read("./style.css");
  assert.match(css, /#terminal \{[^}]*inset: 20px 18px 10px;[^}]*padding: 0;/);
  assert.match(css, /#terminal-stage \{ position: relative; flex: 1; inset: auto; margin-top: calc\(var\(--wallpaper-control-size\) \+ 20px\);/);
  assert.match(css, /\.terminal-footer \{ position: relative; flex: 0 0 auto; min-height: calc\(var\(--wallpaper-control-size\) \+ 16px\);/);
  assert.match(css, /#terminal \{ inset: 2px 12px 8px; padding: 0;/);
  assert.doesNotMatch(css, /\.terminal-footer \{ position: absolute/);
});
test("wallpaper typography controls are labeled and avoid expensive glyph effects", () => {
  const html = read("../index.html");
  const css = read("./style.css");
  for (const id of ["wallpaper-type", "ui-font-size-value", "wallpaper-density", "wallpaper-ink", "renderer-switch"]) {
    assert.ok(html.includes(`id="${id}"`));
  }
  assert.match(css, /body\.wallpaper-mode \.xterm-rows \{ text-shadow: none; -webkit-text-stroke: 0; \}/);
  assert.match(css, /body\.wallpaper-mode #toast \{ bottom: auto; top:/);
  assert.match(css, /--wallpaper-control-size: 36px/);
  assert.doesNotMatch(css, /font-size: [^;}]*v[wh]/);
});
test("custom animated wallpapers do not animate a second time in sidebar and settings previews", () => {
  const main = read("./main.ts");
  assert.match(main, /wallpaperImage\.addEventListener\("load"/);
  assert.match(main, /context\.drawImage\(media, 0, 0, canvas\.width, canvas\.height\)/);
  assert.match(main, /wallpaperVideo\.addEventListener\("loadeddata"/);
  assert.match(main, /image\.src = wallpaperPreviewUrl!/);
  assert.doesNotMatch(main, /image\.src = .*customWallpaperUrl/);
  assert.match(main, /if \(!blob \|\| wallpaperSelectionVersion !== version\) return/);
  assert.match(main, /if \(wallpaperPreviewUrl\) URL\.revokeObjectURL\(wallpaperPreviewUrl\)/);
  assert.doesNotMatch(main, /requestVideoFrameCallback|requestAnimationFrame\([^)]*wallpaper/i);
});
test("composer input has no colored box or focus border and follows the chosen wallpaper ink", () => {
  const css=read("./workbench.css");
  assert.match(css,/\.composer-surface \{[^}]*border: 1px solid transparent;[^}]*background: transparent;/);
  assert.match(css,/\.composer-surface:focus-within \{ border-color: transparent; \}/);
  assert.match(css,/body\.wallpaper-mode \.composer-surface \{ background: transparent; border-color: transparent;/);
  assert.match(css,/body\.wallpaper-mode\[data-wallpaper-ink="light"\] \.composer-surface \{ color: #fff; \}/);
});
