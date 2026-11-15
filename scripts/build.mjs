// Builds dist/cli.js (Node) and extension/dist (Chrome MV3, load unpacked).
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { key } = JSON.parse(readFileSync(join(root, "scripts", "extension-key.json"), "utf8"));
const watch = process.argv.includes("--watch");

// The daemon only trusts this extension ID; make sure the pinned key still produces it.
{
  const { createHash } = await import("node:crypto");
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  const id = [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
  const declared = /EXTENSION_ID = "([a-p]{32})"/.exec(readFileSync(join(root, "src", "protocol.ts"), "utf8"))?.[1];
  if (id !== declared) throw new Error(`extension key gives ID ${id} but src/protocol.ts says ${declared}`);
}
const extOut = join(root, "extension", "dist");

const define = { __VERSION__: JSON.stringify(pkg.version), __BUILD_ID__: JSON.stringify(Date.now().toString(36)) };

const cliOptions = {
  entryPoints: [join(root, "src", "cli.ts")],
  outfile: join(root, "dist", "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  define,
  sourcemap: true,
  logLevel: "info",
};

const extOptions = {
  entryPoints: ["background", "offscreen", "overlay", "popup"].map((n) => join(root, "extension", "src", `${n}.ts`)),
  outdir: extOut,
  bundle: true,
  format: "iife",
  target: "chrome120",
  define,
  logLevel: "info",
};

function manifest() {
  return {
    manifest_version: 3,
    name: "T3 Browser",
    short_name: "T3 Browser",
    version: pkg.version,
    description: "Lets T3 Code agents use your browser on web pages: in their own tab group, with your sign-ins, and Esc to take over.",
    key,
    minimum_chrome_version: "120",
    background: { service_worker: "background.js" },
    action: { default_popup: "popup.html", default_title: "T3 Browser", default_icon: icons() },
    icons: icons(),
    permissions: ["debugger", "tabs", "tabGroups", "scripting", "storage", "offscreen", "alarms", "webNavigation"],
    host_permissions: ["<all_urls>"],
    web_accessible_resources: [],
  };
}

function icons() {
  return { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
}

// ---- icon: violet rounded square with a white pointer, drawn with 4x supersampling -------
function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function icon(size) {
  // unit square coordinates
  const arrow = [
    [0.33, 0.24],
    [0.33, 0.74],
    [0.45, 0.62],
    [0.54, 0.8],
    [0.62, 0.76],
    [0.53, 0.58],
    [0.7, 0.58],
  ];
  const radius = 0.22;
  const inRounded = (u, v) => {
    const cx = Math.min(Math.max(u, radius), 1 - radius);
    const cy = Math.min(Math.max(v, radius), 1 - radius);
    return (u - cx) ** 2 + (v - cy) ** 2 <= radius ** 2;
  };
  const S = 4;
  return png(size, (x, y) => {
    let bg = 0,
      fg = 0;
    for (let sy = 0; sy < S; sy++)
      for (let sx = 0; sx < S; sx++) {
        const u = (x + (sx + 0.5) / S) / size;
        const v = (y + (sy + 0.5) / S) / size;
        if (inRounded(u, v)) {
          bg++;
          if (inPoly(u, v, arrow)) fg++;
        }
      }
    const a = bg / (S * S);
    const f = bg ? fg / bg : 0;
    // gradient violet -> indigo
    const t = y / size;
    const base = [Math.round(124 - 30 * t), Math.round(92 - 20 * t), 255];
    return [
      Math.round(base[0] + (255 - base[0]) * f),
      Math.round(base[1] + (255 - base[1]) * f),
      Math.round(base[2] + (255 - base[2]) * f),
      Math.round(a * 255),
    ];
  });
}

function writeStatic() {
  mkdirSync(join(extOut, "icons"), { recursive: true });
  cpSync(join(root, "extension", "static"), extOut, { recursive: true });
  for (const s of [16, 32, 48, 128]) writeFileSync(join(extOut, "icons", `icon${s}.png`), icon(s));
  writeFileSync(join(extOut, "manifest.json"), JSON.stringify(manifest(), null, 2));
}

if (!watch) {
  rmSync(extOut, { recursive: true, force: true });
  rmSync(join(root, "dist"), { recursive: true, force: true });
}
writeStatic();
if (watch) {
  const a = await context(cliOptions);
  const b = await context(extOptions);
  await Promise.all([a.watch(), b.watch()]);
  console.log("watching…");
} else {
  await Promise.all([build(cliOptions), build(extOptions)]);
}
