import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const previousSelf = globalThis.self;
globalThis.self = globalThis;
const { FitAddon } = require("@xterm/addon-fit");
if (previousSelf === undefined) delete globalThis.self;
else globalThis.self = previousSelf;

test("the actual FitAddon keeps terminal rows outside footer and toolbar space across sizes", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    getComputedStyle: (element) => ({
      getPropertyValue: (property) => element.style[property] || "0px",
    }),
  };
  try {
    for (const [width, height] of [[1280, 820], [600, 440], [390, 844]]) {
      for (const fontSize of [12, 16, 28]) {
        for (const controlSize of [32, 36, 44]) {
          for (const frameHidden of [false, true]) {
            const footerHeight = frameHidden ? 0 : controlSize + 16;
            const top = controlSize + 22;
            const parentHeight = height - top - footerHeight - 8;
            const parentWidth = width - 24;
            const parent = { style: { height: `${parentHeight}px`, width: `${parentWidth}px` } };
            const cell = { width: fontSize * 0.6, height: fontSize * 1.4 * 1.15 };
            const terminal = {
              element: { parentElement: parent, style: {} },
              options: { scrollback: 1000 },
              _core: {
                _renderService: { dimensions: { css: { cell } }, clear() {} },
                viewport: { scrollBarWidth: 14 },
              },
              rows: 0, cols: 0,
              resize(cols, rows) { this.cols = cols; this.rows = rows; },
            };
            const addon = new FitAddon();
            addon.activate(terminal);
            addon.fit();
            assert.equal(terminal.rows, Math.floor(parentHeight / cell.height));
            assert.ok(top + terminal.rows * cell.height <= height - footerHeight - 8);
            assert.ok(terminal.cols * cell.width + 14 <= parentWidth);
            addon.dispose();
          }
        }
      }
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
