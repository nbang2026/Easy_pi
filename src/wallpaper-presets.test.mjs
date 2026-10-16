import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, statSync } from "node:fs";
import { Window } from "happy-dom";
import { DEFAULT_WALLPAPER_ID, WALLPAPER_PRESETS, wallpaperPreset, presetInk, setupWallpaperPresets } from "./wallpaper-presets.ts";

test("six defaults include the unchanged original and five native meteor videos", () => {
  assert.equal(WALLPAPER_PRESETS.length,6);
  assert.equal(DEFAULT_WALLPAPER_ID,"jade");
  assert.equal(wallpaperPreset("original").video,"/wallpaper.mp4");
  assert.equal(wallpaperPreset("untrusted"),undefined);
  assert.equal(new Set(WALLPAPER_PRESETS.map((value)=>value.id)).size,6);
  for (const preset of WALLPAPER_PRESETS) {
    const video=readFileSync(new URL(`../public${preset.video}`,import.meta.url));
    assert.ok(video.includes(Buffer.from("avc1")));
    assert.ok(statSync(new URL(`../public${preset.poster}`,import.meta.url)).size>1000);
  }
  assert.equal(presetInk(wallpaperPreset("pearl")),"dark");
  assert.equal(presetInk(wallpaperPreset("jade")),"light");
});
test("preset buttons use static posters, retain dimensions and dispatch real selections", () => {
  const window=new Window();const old=globalThis.document;globalThis.document=window.document;
  try {
    const container=window.document.createElement("div");window.document.body.append(container);
    const calls=[];let language="zh";
    const picker=setupWallpaperPresets({container,translate:(key)=>`${language}:${key}`,onSelect:(preset)=>calls.push(preset.id)});
    assert.equal(container.querySelector('[data-wallpaper-preset="jade"]').getAttribute("aria-pressed"),"true");
    assert.equal(container.querySelectorAll("button").length,6);
    assert.equal(container.querySelectorAll("video, canvas").length,0);
    container.querySelector('[data-wallpaper-preset="rose"]').click();
    assert.deepEqual(calls,["rose"]);
    picker.select("rose");
    assert.equal(container.querySelectorAll('[aria-pressed="true"]').length,1);
    picker.select("custom");
    assert.equal(container.querySelectorAll('[aria-pressed="true"]').length,0);
    language="en";picker.refreshLanguage();
    assert.equal(container.firstChild.getAttribute("aria-label"),"en:wallpaper.original");
  } finally {globalThis.document=old;window.happyDOM.abort();}
});
test("presets preserve native playback, selection and custom wallpaper restoration", () => {
  const main=readFileSync(new URL("./main.ts",import.meta.url),"utf8");
  assert.match(main,/setVideoSource\(preset\.video\)/);
  assert.match(main,/writeStored\("pi\.wallpaperPreset", preset\.id\)/);
  assert.match(main,/const savedPreset = wallpaperPreset\(readStored\("pi\.wallpaperPreset"\)\)/);
  assert.match(main,/showPresetWallpaper\(wallpaperPreset\(DEFAULT_WALLPAPER_ID\)!/);
  assert.match(main,/if \(wallpaperSelectionVersion !== 0\) return/);
  assert.doesNotMatch(main,/requestVideoFrameCallback|wallpaperVideo\.load\(/);
});
test("relay has only URL, secret and models, and typography remains visible without wallpaper", () => {
  const html=readFileSync(new URL("../index.html",import.meta.url),"utf8");
  assert.doesNotMatch(html,/id="relay-name"/);
  for (const id of ["relay-baseurl","relay-apikey","relay-models"]) assert.match(html,new RegExp(`id="${id}"`));
  const type=html.match(/<button id="wallpaper-type"[^>]+>/)[0];
  assert.doesNotMatch(type,/immersive-only/);
  assert.match(html,/id="sidebar-recents"[^>]*open/);
});
