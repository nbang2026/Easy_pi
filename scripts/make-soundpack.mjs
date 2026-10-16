import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { zipSync, strToU8 } from "fflate";

const argument = process.argv.find((value) => value.startsWith("--output="));
if (!argument) throw new Error("Provide --output=/absolute/path/soundpack.zip");
const output = resolve(argument.slice("--output=".length));
const events = { click: 620, toggle: 760, open: 880, close: 460, send: 1040, typing: 310, scroll: 420 };
const files = {};
const sounds = {};
for (const [event, pitch] of Object.entries(events)) {
  const rate = 24000;
  const length = Math.ceil(rate * (event === "typing" ? 0.025 : event === "scroll" ? 0.035 : 0.07));
  const bytes = new Uint8Array(44 + length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => bytes.set(new TextEncoder().encode(value), at);
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const envelope = Math.min(1, t / 0.002) * Math.exp(-t * 85);
    view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * pitch * t) * envelope * 0.35 * 32767), true);
  }
  const filename = `${event}.wav`;
  files[filename] = bytes;
  sounds[event] = filename;
}
files["soundpack.json"] = strToU8(JSON.stringify({ version: 1, name: "Pi Starter", sounds }, null, 2) + "\n");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, zipSync(files));
console.log(`Generated: ${output}`);
