import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "artifacts/workbench-ui-smoke");
const report = { checkedAt: new Date().toISOString(), scope: "Isolated workbench UI fixture; not native OS or real model acceptance", passed: false, checks: [], errors: [] };
const modulePath = process.env.EASY_PI_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : "playwright");
let server, browser;
await mkdir(output, { recursive: true });
try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error", plugins: [{
    name: "isolated-workbench-fixture",
    transformIndexHtml(html) {
      return html.replace(/<script type="module" src="\/src\/main.ts"><\/script>/, "")
        .replace("</head>", ["style", "workbench", "conversation-view", "theme"].map(name => `<link rel="stylesheet" href="/src/${name}.css">`).join("") + "</head>");
    },
  }] });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.EASY_PI_BROWSER_PATH ? { executablePath: process.env.EASY_PI_BROWSER_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  await context.route("**/*", route => {
    const url=route.request().url();
    return url.startsWith(`${origin}/`) || /^(data|blob):/.test(url) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.goto(origin);
  await page.addStyleTag({content:".workbench-area{height:720px;min-height:0}.terminal-workspace{min-width:360px}.app-main{min-width:0}"});
  await page.evaluate(async () => {
    const { setupWorkbench } = await import("/src/workbench.ts");
    const { setupSendModeControls } = await import("/src/send-mode-controls.ts");
    let mode = "send";
    const calls = [];
    const state = { bridgeId: "isolated-test", ready: true, busy: true, connected: true, cwd: "/isolated-project", session: "fixture-session", model: "Test fixture", task: {
      id: "fixture-run", state: "running", events: [],
      plan: [{ title: "检查现有实现", status: "completed" }, { title: "修复工作台与联网授权", status: "in_progress" }, { title: "自动测试与验收", status: "pending" }], artifacts: ["report.md", "bundle.zip"],
    } };
    const controller = setupWorkbench({ desktop: true, engine: () => "pi", language: () => "zh", mode: () => mode, resize() {}, settings() {}, panelOpened() {}, reconnect: async () => {}, focusTerminal() {}, toast() {},
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "gui_status") return state;
        if (command === "gui_action") return { ok: true };
        if (command === "list_sessions") return { sessions: [] };
        if (command === "git_changes") return { branch: "fixture", refs: [], changes: [] };
        if (command === "run_diagnostics") return { checks: [], checkedAt: Date.now() };
        if (command === "read_workspace_file") return { text: "Isolated test artifact", revision: "fixture" };
      },
    });
    controller.setRuntime({ cwd: state.cwd, bridgeId: state.bridgeId }); controller.setState(state);
    const modes = setupSendModeControls({ root: document.getElementById("sendmode-bar"), initial: mode,
      changed: value => { mode = value; controller.refreshStrings(); }, selected: () => controller.focusInput() });
    document.documentElement.dataset.theme = "light";
    document.querySelectorAll("video").forEach(video => { video.removeAttribute("autoplay");video.pause();video.remove(); });
    window.__workbenchSmoke = { controller, modes, state, calls };
  });
  await page.waitForFunction(() => !document.getElementById("tool-panel").hidden);
  assert.equal(await page.locator("#work-progress-count").textContent(), "1/3");
  assert.equal(await page.locator("#work-artifact-count").textContent(), "2");
  report.checks.push("actual task plan and artifact counts");
  await page.locator("#work-progress-list").evaluate(list => { list.closest("details").open = false; });
  await page.evaluate(() => window.__workbenchSmoke.controller.setState(window.__workbenchSmoke.state));
  assert.equal(await page.locator("#work-progress-list").evaluate(list => list.closest("details").open), false);
  await page.locator("#work-progress-list").evaluate(list => { list.closest("details").open = true; });
  await page.locator("#tool-close").evaluate(button => button.click());
  await page.evaluate(() => window.__workbenchSmoke.controller.setState(window.__workbenchSmoke.state));
  assert.equal(await page.locator("#tool-panel").isVisible(), false);
  await page.locator("#work-open").evaluate(button => button.click());
  await page.locator("#work-artifact-list .file-row").nth(1).evaluate(button => button.click());
  assert.equal(await page.evaluate(() => window.__workbenchSmoke.calls.some(call => call.command === "reveal_workspace_file" && call.args.path === "bundle.zip")), true);
  report.checks.push("collapse, dismissal persistence, manual reopen and native artifact action");
  for (const mode of ["send", "control", "queue"]) {
    await page.locator(`#sendmode-bar [data-mode="${mode}"]`).click();
    assert.equal(await page.locator(`#sendmode-bar [data-mode="${mode}"]`).getAttribute("aria-pressed"), "true");
    await page.locator("#composer-input").fill(`submission-${mode}`);
    await page.locator("#composer-send").click();
    await page.waitForFunction(mode => window.__workbenchSmoke.calls.some(call => call.command === "gui_action"
      && call.args.action === "submit" && call.args.text === `submission-${mode}` && call.args.mode === mode), mode);
    await page.waitForFunction(() => document.getElementById("composer-input").value === "");
  }
  await page.locator('#sendmode-bar [data-mode="send"]').click();
  for (const [key, mode] of [["Control+Enter", "control"], ["Alt+Enter", "queue"]]) {
    await page.locator("#composer-input").fill(`keyboard-${mode}`);
    await page.locator("#composer-input").press(key);
    await page.waitForFunction(mode => window.__workbenchSmoke.calls.some(call => call.command === "gui_action"
      && call.args.action === "submit" && call.args.text === `keyboard-${mode}` && call.args.mode === mode), mode);
    await page.waitForFunction(() => document.getElementById("composer-input").value === "");
  }
  await page.locator("#composer-input").fill("中文候选输入");
  await page.locator("#composer-input").evaluate(input => input.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", isComposing: true, bubbles: true, cancelable: true,
  })));
  assert.equal(await page.locator("#composer-input").inputValue(), "中文候选输入");
  await page.locator("#composer-input").fill("");
  report.checks.push("three send-mode buttons, Control/Alt Enter overrides and IME protection");
  for (const [name, width, height, dark, wallpaper] of [["desktop-light",1280,850,false,false],["desktop-dark-wallpaper",1280,850,true,true],["compact",690,720,false,false]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(({ dark, wallpaper }) => {
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.body.classList.toggle("wallpaper-mode",wallpaper);
    }, { dark, wallpaper });
    const bounds = await page.locator("#tool-panel").boundingBox();
    assert.ok(bounds && bounds.width > 180 && bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `${name}: panel outside viewport ${JSON.stringify(bounds)}`);
    const close = await page.locator("#tool-close").boundingBox();
    assert.ok(close && close.y >= 0 && close.y + close.height <= height, `${name}: close button clipped`);
    if (width > 700) {
      const chat = await page.locator(".terminal-workspace").boundingBox();
      assert.ok(chat && chat.x + chat.width <= bounds.x + 1, `${name}: workbench overlaps input`);
    }
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    report.checks.push(`${name}: bounds, close button and chat separation`);
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.errors.push(error?.stack || String(error)); process.exitCode = 1; }
finally {
  await browser?.close(); await server?.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report,null,2));
}
