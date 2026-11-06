#!/usr/bin/env node
// Builds the .zip that gets uploaded to the Chrome Web Store
// (Developer Dashboard -> your item -> Package -> Upload new package).
//
//   node scripts/package.mjs                 -> dist/character-sheet-roll20-v<version>.zip
//   node scripts/package.mjs --no-localhost  -> same, without the localhost / 127.0.0.1
//                                               host permissions and content-script matches
//
// No dependencies (plain Node 18+). Only what the extension needs at runtime
// goes into the zip - manifest.json, app/ and assets/ - never .git, .idea,
// README, scripts/, store/ or dist/. Before writing, it checks the manifest
// against the Web Store limits and that every file it references exists, so
// a broken package fails here instead of in the dashboard.

import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INCLUDE = ["manifest.json", "app", "assets"];
const LOCAL_PATTERN = /^(\*|https?):\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i;
const stripLocalhost = process.argv.includes("--no-localhost");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// --- manifest checks ----------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

if (manifest.manifest_version !== 3) fail("manifest_version must be 3.");
if (!manifest.name || manifest.name.length > 75) fail(`name must be 1-75 characters (is ${manifest.name?.length ?? 0}).`);
if (manifest.short_name && manifest.short_name.length > 12) {
  console.warn(`! short_name is ${manifest.short_name.length} characters - Chrome may truncate it past 12.`);
}
if (!manifest.description || manifest.description.length > 132) {
  fail(`description must be 1-132 characters (is ${manifest.description?.length ?? 0}) - the Web Store rejects longer ones.`);
}
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version) || manifest.version.split(".").some((part) => Number(part) > 65535)) {
  fail(`version "${manifest.version}" must be 1-4 dot-separated integers (0-65535).`);
}
if (!manifest.icons || !manifest.icons["128"]) fail("icons.128 is required by the Web Store.");

const referenced = new Set([
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
].filter(Boolean));

// ES module imports of the service worker (e.g. ./chat-format.js).
if (manifest.background?.service_worker) {
  const workerPath = manifest.background.service_worker;
  const source = readFileSync(join(ROOT, workerPath), "utf8");
  for (const match of source.matchAll(/^\s*import\s[^"']*["'](\.[^"']+)["']/gm)) {
    referenced.add(relative(ROOT, resolve(ROOT, dirname(workerPath), match[1])).split(sep).join("/"));
  }
}

for (const file of referenced) {
  if (!existsSync(join(ROOT, file))) fail(`manifest references ${file}, which doesn't exist.`);
}

// Remote code is banned in MV3 / by Web Store policy - catch the obvious forms.
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
for (const file of walk(join(ROOT, "app")).filter((f) => f.endsWith(".js"))) {
  const source = readFileSync(file, "utf8");
  if (/\beval\s*\(|new\s+Function\s*\(|<script[^>]+src=["']https?:/i.test(source)) {
    fail(`${relative(ROOT, file)} looks like it runs remote/dynamic code (eval / new Function / remote <script>).`);
  }
}

// --- optional: drop localhost patterns from the packaged manifest ----------------

const packagedManifest = structuredClone(manifest);
if (stripLocalhost) {
  const keep = (pattern) => !LOCAL_PATTERN.test(pattern);
  packagedManifest.host_permissions = (packagedManifest.host_permissions || []).filter(keep);
  for (const entry of packagedManifest.content_scripts || []) entry.matches = entry.matches.filter(keep);
  packagedManifest.content_scripts = (packagedManifest.content_scripts || []).filter((entry) => entry.matches.length > 0);
}

// --- zip (store method for tiny files, deflate otherwise) ----------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const files = INCLUDE.flatMap((entry) => {
  const full = join(ROOT, entry);
  if (!existsSync(full)) fail(`${entry} is missing.`);
  return statSync(full).isDirectory() ? walk(full) : [full];
})
  .map((full) => relative(ROOT, full).split(sep).join("/")) // forward slashes - backslashes break the upload
  .filter((name) => !/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name))
  .sort();

const { time, day } = dosDateTime(new Date());
const locals = [];
const centrals = [];
let offset = 0;

for (const name of files) {
  const raw = name === "manifest.json"
    ? Buffer.from(`${JSON.stringify(packagedManifest, null, 2)}\n`, "utf8")
    : readFileSync(join(ROOT, name));
  const deflated = deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const nameBuffer = Buffer.from(name, "utf8");
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(useDeflate ? 8 : 0, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, nameBuffer, data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(useDeflate ? 8 : 0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(day, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuffer);

  offset += local.length + nameBuffer.length + data.length;
}

const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const outDir = join(ROOT, "dist");
mkdirSync(outDir, { recursive: true });
const outName = `character-sheet-roll20-v${manifest.version}${stripLocalhost ? "-nolocal" : ""}.zip`;
const outPath = join(outDir, outName);
writeFileSync(outPath, Buffer.concat([...locals, ...centrals, end]));

console.log(`✓ ${relative(ROOT, outPath)} - ${files.length} files, v${manifest.version}${stripLocalhost ? ", without localhost" : ""}`);
console.log("  Upload it in the Chrome Web Store Developer Dashboard (Package -> Upload new package).");
