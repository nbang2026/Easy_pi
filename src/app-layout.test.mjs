import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { hasIcon } from "./icons.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const sourceFiles = (directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory()
    ? sourceFiles(join(directory, entry.name))
    : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);

test("easy_pi branding preserves Pi core storage and internal build identity", () => {
  const config = JSON.parse(read("../src-tauri/tauri.conf.json"));
  const html = read("../index.html");
  assert.equal(config.productName, "easy_pi");
  assert.equal(config.app.windows[0].title, "easy_pi");
  assert.equal(config.identifier, "com.pi.desktop");
  assert.match(html, /<title>easy_pi/);
  assert.match(html, /<h1>easy_pi<\/h1>/);
  assert.match(html, /<span>easy_pi Desktop<\/span>/);
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
  assert.match(html, /id="work-fullscreen-toggle"[^>]+data-i18n-title="ui.enterFullscreen"/);
  assert.match(html, /id="work-sidebar-toggle"[^>]+aria-controls="quickbar"/);
});
test("every static interface icon resolves to its intended Lucide glyph", () => {
  const sources = [read("../index.html"), ...sourceFiles(new URL("../src", import.meta.url).pathname)
    .map((path) => readFileSync(path, "utf8"))];
  const names = sources.flatMap((source) =>
    [...source.matchAll(/data-icon=["']([^"']+)["']/g)].map((match) => match[1]));
  const missing = [...new Set(names.filter((name) => !hasIcon(name)))];
  assert.deepEqual(missing, []);
});
test("language setup applies localized names to icon-only search fields", () => {
  const main = read("./main.ts");
  assert.match(main, /import \{ applyLocalizedControlLabels \} from "\.\/accessibility"/);
  assert.match(main, /applyLocalizedControlLabels\(document, t\)/);
});
test("wallpaper has no full-screen dimmer and immersive frames retain the restore controls", () => {
  const html = read("../index.html");
  const css = read("./style.css");
  assert.doesNotMatch(html, /wallpaper-shade/);
  assert.doesNotMatch(css, /wallpaper-shade|--terminal-shade/);
  assert.match(css, /body\.wallpaper-mode \.modal-backdrop\s*\{[^}]*background:\s*transparent;[^}]*backdrop-filter:\s*none;/);
  assert.match(css, /body\.wallpaper-mode #terminal-welcome\s*\{[^}]*background:\s*transparent;/);
  assert.doesNotMatch(css, /body\.frame-hidden \.terminal-tools > :not\(#fullscreen-toggle, #frame-toggle\)/);
  assert.match(css, /body:is\(\.wallpaper-mode, \.frame-hidden\) \.terminal-tools \.icon-button/);
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
  assert.match(css, /body:is\(\.wallpaper-mode, \.frame-hidden\) \.terminal-workspace \{[^}]*padding-top: calc\(var\(--wallpaper-control-size\) \+ 20px\);/);
  assert.match(css, /#terminal-stage \{ position: relative; flex: 1; inset: auto; margin-top: 0;/);
  assert.match(css, /body:is\(\.wallpaper-mode, \.frame-hidden\) \.agent-session-strip \{[^}]*position: relative;[^}]*top: auto;[^}]*height: 42px;/);
  assert.match(css, /\.terminal-footer \{ position: relative; flex: 0 0 auto; min-height: calc\(var\(--wallpaper-control-size\) \+ 16px\);/);
  assert.match(css, /#terminal \{ inset: 2px 12px 8px; padding: 0;/);
  assert.doesNotMatch(css, /\.terminal-footer \{ position: absolute/);
  assert.doesNotMatch(css, /body\.frame-hidden \.composer \{ display: none; \}/);
  assert.doesNotMatch(css, /body\.frame-hidden \.terminal-footer/);
  assert.doesNotMatch(css, /body\.frame-hidden \.app-header/);
  assert.doesNotMatch(css, /body\.frame-hidden \.terminal-tools > :not/);
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
test("terminal appearance accepts custom color and locally imported fonts", () => {
  const html = read("../index.html");
  const main = read("./main.ts");
  const css = read("./style.css");
  assert.match(html, /id="terminal-font-color" type="color"/);
  assert.match(html, /id="custom-font-file" type="file" accept="[^"]*\.ttf[^"]*\.otf[^"]*\.woff[^"]*\.woff2/);
  assert.match(main, /idbPut\("custom-font", file\)/);
  assert.match(main, /idbGet\("custom-font"\)/);
  assert.match(main, /new FontFace\(CUSTOM_FONT_FAMILY, await blob\.arrayBuffer\(\)\)\.load\(\)/);
  assert.match(main, /document\.fonts\.delete\(customFontFace\)/);
  assert.match(css, /body \{[^}]*font-family: var\(--app-font-family\)/);
});

test("chat typography follows the same font controls as the native terminal", () => {
  const main = read("./main.ts");
  const css = read("./conversation-view.css");
  assert.match(main, /setProperty\("--conversation-font-size",/);
  assert.match(main, /setProperty\("--conversation-custom-color", terminalFontColor\)/);
  assert.match(main, /removeProperty\("--conversation-custom-color"\)/);
  assert.match(css, /#conversation-view \.conversation-answer\s*\{[^}]*font-size:\s*var\(--conversation-font-size/);
  assert.match(css, /color:\s*var\(--conversation-custom-color,\s*inherit\)/);
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
test("responsive dialogs and work tools stay inside short viewports", () => {
  const style = read("./style.css");
  const workbench = read("./workbench.css");
  const html = read("../index.html");
  assert.match(style, /\.modal-backdrop \{[^}]*overflow: auto;[^}]*min-height: 0;/);
  assert.match(style, /\.settings-dialog \{[^}]*height: min\(760px, calc\(100dvh - 32px\)\);[^}]*max-height: calc\(100dvh - 32px\);/);
  assert.match(workbench, /\.work-tools-menu \{[^}]*max-height: min\(360px, max\(120px, calc\(100dvh - 96px\)\)\);[^}]*overflow-y: auto;/);
  assert.match(workbench, /@media \(max-width: 700px\) \{[\s\S]*\.tool-panel-header #work-sidebar-toggle, \.tool-panel-header #work-fullscreen-toggle \{ display: inline-flex; \}/);
  assert.match(workbench, /@container session \(max-width: 560px\) \{[\s\S]*\.model-controls \.model-trigger \{ flex: 1 1 100%;/);
  assert.match(workbench, /@container session \(max-width: 360px\) \{[\s\S]*\.model-controls \.effort-control \{ flex-basis: 100%;/);
  assert.match(html, /<div class="conversation-more-anchor">[\s\S]*id="conversation-more"[\s\S]*id="conversation-more-menu"/);
});
test("conversation and Claude overlays preserve mode-specific surfaces", () => {
  const conversation = read("./conversation-view.css");
  const claude = read("./claude-view.css");
  assert.match(conversation, /\.conversation-more-anchor \{ position: relative;/);
  assert.match(conversation, /\.conversation-more-menu \{[^}]*right: 0;[^}]*max-width: min\(184px, calc\(100vw - 24px\)\);/);
  assert.match(conversation, /body\.terminal-view #conversation-view \{ display: none !important; \}/);
  assert.match(conversation, /#terminal \{[^}]*visibility: hidden;[^}]*pointer-events: none;/);
  assert.match(claude, /\.claude-view-modal \{[^}]*overflow: auto;[^}]*background: #101e1a55;[^}]*backdrop-filter: blur\(3px\);/);
  assert.match(claude, /body\.wallpaper-mode \.claude-view-modal \{ background: transparent; backdrop-filter: none; \}/);
});
test("chat controls collapse duplicates, keep the engine distinct from Agent roles, and place sessions by the composer", () => {
  const html = read("../index.html");
  const workbench = read("./workbench.css");
  const sessions = read("./agent-session-strip.ts");
  const transcriptEnd = html.indexOf('id="drop-indicator"');
  const sessionsIndex = html.indexOf('id="agent-session-strip"');
  const composerIndex = html.indexOf('id="composer"');
  assert.ok(transcriptEnd < sessionsIndex && sessionsIndex < composerIndex, "agent sessions should be between the transcript and composer");
  assert.equal((html.match(/id="agent-select"/g) || []).length, 1);
  assert.match(html, /class="agent-control-caption"[^>]*>Agent 角色<\/span><select id="role-select"/);
  assert.match(html, /<select id="agent-select"[^>]*>[\s\S]*value="claude"[\s\S]*<\/select>/);
  assert.doesNotMatch(html.match(/<select id="role-select"[\s\S]*?<\/select>/)?.[0] || "", /value="claude"|engine:claude/);
  assert.match(workbench, /:is\(#thinking-select, #agent-select, #role-select\)/);
  assert.match(workbench, /\.agent-control\.is-active #role-select \{ color: #197c68; \}/);
  assert.match(sessions, /children\.length \? \[main, \.\.\.children\] : \[\]/);
  assert.match(html, /<div class="conversation-actions" role="group" aria-label="回答操作" data-i18n-aria="ui.answerActions" hidden>/);
  assert.doesNotMatch(html, /<header class="conversation-actions"/);
});
test("conversation, composer, and work tools share one width and aligned workspace gutters", () => {
  const style = read("./style.css");
  const workbench = read("./workbench.css");
  const conversation = read("./conversation-view.css");
  assert.match(style, /--app-inline-gutter:\s*22px/);
  assert.match(style, /--conversation-content-width:\s*1040px/);
  assert.match(style, /\.app-header \{[^}]*padding: 0 var\(--app-inline-gutter\)/);
  assert.match(style, /\.terminal-workspace \{[^}]*margin: var\(--workspace-top-gutter\) var\(--app-inline-gutter\) 0/);
  assert.match(workbench, /\.composer-surface \{[^}]*max-width: var\(--conversation-content-width\)/);
  assert.match(workbench, /\.input-tools-inner \{[^}]*max-width: var\(--conversation-content-width\)/);
  assert.match(conversation, /\.conversation-scroll \{[^}]*padding: 28px var\(--composer-inline-padding\) 36px/);
  assert.match(conversation, /\.conversation-messages \{[^}]*max-width: var\(--conversation-content-width\)/);
  assert.match(conversation, /\.conversation-assistant \{[^}]*max-width: var\(--conversation-content-width\)/);
  assert.doesNotMatch(`${workbench}\n${conversation}`, /max-width:\s*(?:820|930)px/);
});
