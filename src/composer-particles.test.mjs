import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { normalizeComposerParticleEffect, setupComposerParticles } from "./composer-particles.ts";

test("particle settings normalize unknown values to off", () => {
  assert.equal(normalizeComposerParticleEffect("rainbow"), "rainbow");
  assert.equal(normalizeComposerParticleEffect("fireworks"), "fireworks");
  assert.equal(normalizeComposerParticleEffect("starlight"), "starlight");
  assert.equal(normalizeComposerParticleEffect("bubbles"), "bubbles");
  assert.equal(normalizeComposerParticleEffect("comet"), "comet");
  assert.equal(normalizeComposerParticleEffect("pulse"), "pulse");
  assert.equal(normalizeComposerParticleEffect("invalid"), "off");
});

test("composer particles respect reduced motion, IME composition and disposal", () => {
  const window = new Window();
  window.document.write(`<div id="composer-input-wrap"><textarea id="composer-input"></textarea><div id="composer-particles"></div></div>`);
  const listeners = new Set();
  const media = {
    matches: true,
    addEventListener(_name, listener) { listeners.add(listener); },
    removeEventListener(_name, listener) { listeners.delete(listener); },
  };
  Object.defineProperty(window, "matchMedia", { value: () => media, configurable: true });
  const input = window.document.getElementById("composer-input");
  const host = window.document.getElementById("composer-input-wrap");
  const layer = window.document.getElementById("composer-particles");
  input.value = "hello";
  const effect = setupComposerParticles({ input, host, initialEffect: "rainbow", windowRef: window });
  try {
    assert.equal(layer.dataset.motion, "reduced");
    input.dispatchEvent(new window.Event("input"));
    assert.equal(layer.childElementCount, 0);

    media.matches = false;
    for (const listener of listeners) listener();
    assert.equal(layer.dataset.motion, "full");
    input.dispatchEvent(new window.Event("compositionstart"));
    input.dispatchEvent(new window.Event("input"));
    assert.equal(layer.childElementCount, 0);
    input.dispatchEvent(new window.Event("compositionend"));
    assert.equal(layer.childElementCount, 9);

    effect.setEffect("off");
    assert.equal(layer.childElementCount, 0);
    effect.setEffect("starlight");
    input.dispatchEvent(new window.Event("input"));
    assert.equal(layer.childElementCount, 6);
  } finally {
    effect.dispose();
    input.dispatchEvent(new window.Event("input"));
    assert.equal(layer.childElementCount, 0);
    window.happyDOM.abort();
  }
});

test("typing, caret navigation and every visual preset trigger bounded feedback", () => {
  const window = new Window();
  window.document.write(`<div id="composer-input-wrap"><textarea id="composer-input"></textarea><div id="composer-particles"></div></div>`);
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: false }), configurable: true });
  const input = window.document.getElementById("composer-input");
  const layer = window.document.getElementById("composer-particles");
  const effect = setupComposerParticles({ input, host: window.document.getElementById("composer-input-wrap"), initialEffect: "rainbow", windowRef: window, now: () => 0 });
  try {
    input.value = "hello";
    input.dispatchEvent(new window.Event("input"));
    assert.equal(layer.childElementCount, 9);
    input.dispatchEvent(new window.KeyboardEvent("keyup", { key: "x" }));
    assert.equal(layer.childElementCount, 9);
    effect.setEffect("pulse");
    input.dispatchEvent(new window.Event("input"));
    assert.equal(layer.childElementCount, 6);
    effect.setEffect("bubbles");
    input.dispatchEvent(new window.Event("input"));
    assert.equal(layer.childElementCount, 9);
    effect.setEffect("comet");
    input.dispatchEvent(new window.Event("input"));
    assert.equal(layer.childElementCount, 9);
  } finally {
    effect.dispose();
    window.happyDOM.abort();
  }
});

test("particle presets cancel pending timers and shortcuts never create particles", () => {
  const window = new Window();
  window.document.write('<div id="host"><textarea id="input"></textarea><div id="composer-particles"></div></div>');
  const pending = new Map();
  let id = 0;
  let timestamp = 0;
  window.setTimeout = callback => { pending.set(++id, callback); return id; };
  window.clearTimeout = timer => { pending.delete(timer); };
  const input = window.document.getElementById("input");
  const layer = window.document.getElementById("composer-particles");
  const effect = setupComposerParticles({ input, host: window.document.getElementById("host"), initialEffect: "rainbow", windowRef: window, now: () => timestamp });
  try {
    input.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Escape" }));
    input.dispatchEvent(new window.KeyboardEvent("keyup", { key: "a", metaKey: true }));
    assert.equal(layer.childElementCount, 0);
    input.dispatchEvent(new window.Event("input"));
    assert.equal(pending.size, 9);
    for (const callback of [...pending.values()]) callback();
    assert.equal(pending.size, 0);
    assert.equal(layer.childElementCount, 0);
    timestamp += 100;
    input.dispatchEvent(new window.Event("input"));
    assert.equal(pending.size, 9);
    effect.setEffect("comet");
    assert.equal(pending.size, 0);
    input.dataset.particleSuppressed = "true";
    input.dispatchEvent(new window.Event("select"));
    assert.equal(layer.childElementCount, 0);
    delete input.dataset.particleSuppressed;
    timestamp += 100;
    input.dispatchEvent(new window.Event("input"));
    assert.equal(pending.size, 9);
    effect.dispose();
    assert.equal(pending.size, 0);
  } finally { effect.dispose(); window.happyDOM.abort(); }
});
