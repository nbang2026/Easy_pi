import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, process.env.EASY_PI_UI_REPORT_DIR || "artifacts/ui-smoke");
const modulePath = process.env.EASY_PI_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : "playwright");
const report = { checkedAt: new Date().toISOString(), scope: "Isolated Chromium UI; not native macOS/Windows acceptance or a real model run", passed: false, checks: [], errors: [] };
let server;
let browser;
await mkdir(output, { recursive: true });

async function check(name, run) {
  await run();
  report.checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false }, clearScreen: false, logLevel: "error" });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.EASY_PI_BROWSER_PATH ? { executablePath: process.env.EASY_PI_BROWSER_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1180, height: 780 } });
  await context.route("**/*", route => {
    const url = route.request().url();
    return url.startsWith(`${origin}/`) || /^(data|blob):/.test(url) ? route.continue() : route.abort();
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem("pi.uiSmokeInitialized")) {
      localStorage.setItem("pi.theme", "light");
      localStorage.setItem("pi.wallpaper", "off");
      localStorage.setItem("pi.soundEnabled", "0");
      localStorage.setItem("pi.uiSmokeInitialized", "1");
    }
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  async function fixture() {
    await page.waitForFunction(() => document.body.style.getPropertyValue("--conversation-font-size"));
    await page.evaluate(async () => {
      const { setupConversationView } = await import("/src/conversation-view.ts");
      const original = document.getElementById("conversation-view");
      const root = original.cloneNode(true);
      original.replaceWith(root);
      const calls = { continued: 0 };
      const view = setupConversationView({ root, nextStepEnabled: () => true, outlineEnabled: () => true, onContinue: () => calls.continued++ });
      view.consume({ role: "assistant", messageId: "smoke-answer", text: "界面回归测试：字号、颜色与菜单交互。\n" + "这是一段用于检查换行与滚动的测试正文。".repeat(50), append: false });
      view.setState({ connected: true, ready: true });
      window.__easyPiUiSmoke = { view, calls };
    });
  }
  const answerStyle = () => page.locator(".conversation-answer").evaluate(element => {
    const style = getComputedStyle(element);
    return { size: Number.parseFloat(style.fontSize), color: style.color };
  });
  const openAppearance = async () => {
    await page.locator("#settings-toggle").evaluate(element => element.click());
    await page.locator('[data-settings-group="personal"]').click();
    await page.locator("#tab-appearance").click();
  };
  const menuWithinRoot = async () => {
    const bounds = await page.evaluate(() => {
      const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      return { root: rect("conversation-view"), menu: rect("conversation-quick-actions-menu") };
    });
    assert.ok(bounds.menu.width > 0 && bounds.menu.height > 0, "menu must be visible");
    assert.ok(bounds.menu.left >= bounds.root.left - 1 && bounds.menu.right <= bounds.root.right + 1, JSON.stringify(bounds));
    assert.ok(bounds.menu.top >= bounds.root.top - 1 && bounds.menu.bottom <= bounds.root.bottom + 1, JSON.stringify(bounds));
  };
  await page.goto(origin);
  await fixture();
  await check("font size and custom color immediately affect chat text", async () => {
    const initial = await answerStyle();
    await openAppearance();
    await page.locator("#font-increase").click();
    await page.locator("#terminal-font-color").evaluate(input => { input.value = "#c13f70"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.locator("#settings-close").click();
    const changed = await answerStyle();
    assert.equal(changed.size, initial.size + 1);
    assert.equal(changed.color, "rgb(193, 63, 112)");
  });
  await check("dark theme and wallpaper preserve the explicit text color", async () => {
    await openAppearance();
    await page.locator("#theme-select").selectOption("dark");
    await page.locator("#settings-close").click();
    await page.locator("#wallpaper-toggle").click();
    assert.equal((await answerStyle()).color, "rgb(193, 63, 112)");
    await page.screenshot({ path: resolve(output, "wallpaper-dark.png") });
  });
  await check("dragging does not open the menu and the next click works", async () => {
    const toggle = page.locator("#conversation-quick-actions-toggle");
    const before = await toggle.boundingBox();
    const target = await page.locator("#conversation-view").boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 50, target.y + 50, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.locator("#conversation-quick-actions-menu").isHidden(), true);
    await toggle.click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "conversation-quick-copy");
    await menuWithinRoot();
    await page.screenshot({ path: resolve(output, "drag-menu.png") });
  });
  await check("an open menu remains inside a resized minimum-size window", async () => {
    await page.setViewportSize({ width: 600, height: 440 });
    await page.waitForTimeout(150);
    await menuWithinRoot();
    await page.screenshot({ path: resolve(output, "minimum-window.png") });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#conversation-quick-actions-menu").isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "conversation-quick-actions-toggle");
  });
  await check("busy-state clicks cannot submit another task", async () => {
    await page.evaluate(() => window.__easyPiUiSmoke.view.setState({ busy: true }));
    await page.evaluate(() => {
      document.getElementById("conversation-continue").click();
      document.getElementById("conversation-quick-continue").click();
    });
    assert.equal(await page.evaluate(() => window.__easyPiUiSmoke.calls.continued), 0);
  });
  await check("font preferences survive reload and reset restores theme defaults", async () => {
    await page.setViewportSize({ width: 1180, height: 780 });
    await page.reload();
    await fixture();
    assert.equal((await answerStyle()).color, "rgb(193, 63, 112)");
    await openAppearance();
    await page.locator("#terminal-font-color-reset").click();
    await page.locator("#settings-close").click();
    assert.equal(await page.evaluate(() => document.body.style.getPropertyValue("--conversation-custom-color")), "");
    assert.notEqual((await answerStyle()).color, "rgb(193, 63, 112)");
    await page.screenshot({ path: resolve(output, "reset-theme.png") });
  });
  assert.deepEqual(report.errors, [], "unexpected page errors");
  report.passed = true;
} catch (error) {
  report.errors.push(error.stack || String(error));
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await browser?.close();
  await server?.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
