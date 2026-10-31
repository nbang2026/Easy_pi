import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "artifacts/long-task-ui-smoke");
const { chromium } = await import(process.env.EASY_PI_PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.EASY_PI_PLAYWRIGHT_MODULE)).href : "playwright");
const report = { checkedAt: new Date().toISOString(), scope: "Isolated UI, not native desktop or real long-running model acceptance", passed: false, checks: [], errors: [] };
let server, browser;
await mkdir(output, { recursive: true });
try {
  server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "isolated-long-task-fixture",
    transformIndexHtml: html => html.replace(/<script type="module" src="\/src\/main.ts"><\/script>/, "")
      .replace("</head>", '<link rel="stylesheet" href="/src/style.css"><link rel="stylesheet" href="/src/harness.css"><link rel="stylesheet" href="/src/conversation-view.css"></head>'),
  }] });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.EASY_PI_BROWSER_PATH ? { executablePath: process.env.EASY_PI_BROWSER_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  await page.route("**/*", route => route.request().url().startsWith(`${origin}/`) || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort());
  page.on("pageerror", error => report.errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async () => {
    const { setupHarnessSettings } = await import("/src/harness-settings.ts");
    const conversation = document.getElementById("conversation-view").cloneNode(true);
    const pane = document.createElement("main"); pane.id = "pane-harness";
    pane.style.cssText = "max-width:680px;margin:24px auto;padding:16px;overflow:auto";
    document.body.replaceChildren(pane);
    let settings = { mode: "project", maxMinutes: 30, maxTurns: 100, maxToolCalls: 200, maxTokens: 500000, maxCost: 5, maxRepeatedFailures: 3 };
    const ui = setupHarnessSettings({ language: () => "zh", invoke: async (_command, args) => {
      const value = JSON.parse(args.text);
      if (value.action === "history") return { data: [] };
      if (value.action === "configure") settings = value.settings;
      return { data: { workspace: "UI regression fixture", revision: "r1", settings, current: null } };
    } });
    await ui.refresh();
    window.__longTaskSmoke = { ui, conversation };
  });
  const toggle = page.locator("#harness-unlimited");
  await toggle.check();
  assert.equal(await page.locator("#harness-limits").isVisible(), false);
  assert.equal(await page.locator("#harness-maxMinutes").isDisabled(), true);
  await page.locator("#harness-save").click();
  await page.waitForFunction(() => !document.getElementById("harness-save").disabled);
  assert.equal(await toggle.isChecked(), true);
  await page.screenshot({ path: resolve(output, "unlimited.png"), fullPage: true });
  report.checks.push("unlimited hides inputs and survives saving/reloading");
  await toggle.focus(); await page.keyboard.press("Space");
  assert.equal(await page.locator("#harness-limits").isVisible(), true);
  assert.equal(await page.locator("#harness-maxMinutes").inputValue(), "30");
  for (const [name, width, height] of [["desktop", 1180, 780], ["compact", 600, 700]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.locator("#harness-maxMinutes").isEnabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(output, `${name}-limits.png`), fullPage: true });
    report.checks.push(`${name}: finite inputs fit viewport and remain keyboard accessible`);
  }
  report.stream = await page.evaluate(async () => {
    const { setupConversationView } = await import("/src/conversation-view.ts");
    window.__longTaskSmoke.ui.dispose();
    const root = window.__longTaskSmoke.conversation;
    document.body.replaceChildren(root);
    root.hidden = false; root.style.cssText = "display:flex;height:650px;min-height:0";
    const view = setupConversationView({ root });
    const start = performance.now();
    for (let i = 0; i < 500; i++) view.consume({ role: "assistant", messageId: "long", text: "Long answer regression fixture. ".repeat(6), append: true });
    const answer = root.querySelector(".conversation-answer");
    const result = { durationMs: Math.round(performance.now() - start), textNodes: answer.childNodes.length, characters: answer.textContent.length };
    view.dispose(); return result;
  });
  assert.equal(report.stream.textNodes, 1);
  assert.equal(report.stream.characters, 96000);
  assert.ok(report.stream.durationMs < 10000, "stream fixture must not stall for 10 seconds");
  report.checks.push("500 streamed deltas retain one text node and complete without a 10-second stall");
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(error.stack || String(error)); process.exitCode = 1;
} finally {
  await browser?.close(); await server?.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
