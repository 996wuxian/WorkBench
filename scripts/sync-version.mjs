import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relPath) {
  return JSON.parse(readFileSync(resolve(root, relPath), "utf8"));
}

function writeJson(relPath, value) {
  writeFileSync(
    resolve(root, relPath),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

const pkg = readJson("package.json");
const { version } = pkg;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[sync-version] invalid package.json version: ${JSON.stringify(version)}`);
  process.exit(1);
}

const tauriPath = "src-tauri/tauri.conf.json";
const tauri = readJson(tauriPath);
if (tauri.version !== version) {
  const oldVersion = tauri.version;
  tauri.version = version;
  writeJson(tauriPath, tauri);
  console.log(`[sync-version] ${tauriPath}: ${oldVersion} -> ${version}`);
}

const lockPath = "pnpm-lock.yaml";
const lockPathAbs = resolve(root, lockPath);
let lock = readFileSync(lockPathAbs, "utf8");
const nextLock = lock.replace(
  /^(\s{4}version:\s+).+$/m,
  `$1${version}`,
);
if (nextLock !== lock) {
  lock = nextLock;
  writeFileSync(lockPathAbs, lock, "utf8");
  console.log(`[sync-version] ${lockPath}: root importer version -> ${version}`);
}

const cargoPath = "src-tauri/Cargo.toml";
const cargoPathAbs = resolve(root, cargoPath);
const cargo = readFileSync(cargoPathAbs, "utf8");
const eol = cargo.includes("\r\n") ? "\r\n" : "\n";
const lines = cargo.split(/\r?\n/);
let inPackage = false;
let cargoChanged = false;

for (let i = 0; i < lines.length; i += 1) {
  const trimmed = lines[i].trim();
  if (/^\[[^\]]+\]$/.test(trimmed)) {
    inPackage = trimmed === "[package]";
    continue;
  }
  if (inPackage && /^version\s*=\s*"[^"]*"\s*$/.test(trimmed)) {
    const updated = lines[i].replace(/"[^"]*"/, `"${version}"`);
    if (updated !== lines[i]) {
      lines[i] = updated;
      cargoChanged = true;
    }
    break;
  }
}

if (cargoChanged) {
  writeFileSync(cargoPathAbs, lines.join(eol), "utf8");
  console.log(`[sync-version] ${cargoPath}: version -> ${version}`);
}

console.log(`[sync-version] done: ${version}`);
