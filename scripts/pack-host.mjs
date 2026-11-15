import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

/**
 * Собирает папку для загрузки на обычный хостинг (PHP + статика).
 *
 *   npm run pack            # dist + host/  → upload/ и upload.zip
 *   npm run pack -- --no-bundles
 *
 * upload/ — это содержимое будущей папки сайта, например /webp_assets/:
 *
 *   upload/index.html
 *   upload/assets/…
 *   upload/wasm/…
 *   upload/bundles/…      (можно исключить флагом --no-bundles)
 *   upload/host/proxy.php
 *   upload/host/cacert.pem
 *   upload/host/.htaccess
 *   upload/host/.env.example
 *
 * Кладём в архив и .env.example, а не .env: на сервере файл .env создаётся
 * из шаблона и уже не попадает ни в git, ни в архив.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const host = join(root, "host");
const output = join(root, "upload");
const zipPath = join(root, "upload.zip");

const withBundles = !process.argv.includes("--no-bundles");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, base)));
    else if (entry.isFile()) files.push(relative(base, full).split(sep).join("/"));
  }
  return files;
}

if (!(await exists(join(dist, "index.html")))) {
  console.error("Нет dist/index.html — сначала выполните `npm run build`.");
  process.exit(1);
}

await rm(output, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(output, { recursive: true });

await cp(dist, output, { recursive: true });

if (!withBundles) {
  await rm(join(output, "bundles"), { recursive: true, force: true });
  await mkdir(join(output, "bundles"), { recursive: true });

  // Без локальных копий сайт берёт бандлы с сервера игры через прокси.
  const game = JSON.parse(await readFile(join(root, "scripts", "game-bundles.json"), "utf8"));
  const source = game.source || "https://blockade3d.com/ClassicBundles/";
  const bundles = (game.names || []).map((name) => ({ name, url: source + name }));
  await writeFile(
    join(output, "bundles", "bundles.json"),
    JSON.stringify({ source, bundles }, null, 2) + "\n",
  );
  console.log(`bundles/*.webp исключены: сайт будет брать ${bundles.length} бандлов с ${source}`);
}

const hostFiles = await exists(host) ? await readdir(host) : [];
const skip = new Set([".env", "cache", "proxy.config.php"]);
let copiedHost = 0;
for (const name of hostFiles) {
  if (skip.has(name) || name.endsWith(".lock") || name.endsWith(".tmp")) continue;
  await cp(join(host, name), join(output, "host", name), { recursive: true });
  copiedHost += 1;
}
if (!copiedHost) {
  console.warn("Внимание: папка host/ пуста или отсутствует — прокси в сборку не попадёт.");
}
const envExample = join(host, ".env");
if (await exists(envExample)) {
  await cp(envExample, join(output, "host", ".env.example"));
}

const files = await walk(output);
const sizes = new Map();
let total = 0;
const zipEntries = {};
for (const name of files) {
  const bytes = await readFile(join(output, name));
  sizes.set(name, bytes.byteLength);
  total += bytes.byteLength;
  // WebP-бандлы уже сжаты, пережимать их бессмысленно и долго.
  zipEntries[name] = [new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), { level: name.endsWith(".webp") ? 0 : 6 }];
}

const archive = zipSync(zipEntries, { level: 6 });
await writeFile(zipPath, archive);

const biggest = [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} МБ`;

console.log(`\nГотово: ${files.length} файлов, ${mb(total)} → upload/`);
console.log(`Архив: upload.zip (${mb(archive.byteLength)})`);
console.log("\nСамое тяжёлое:");
for (const [name, bytes] of biggest) console.log(`  ${name} — ${mb(bytes)}`);
console.log(`
Что делать дальше:
  1. Откройте файловый менеджер хостинга (или FTP) для папки сайта.
  2. Загрузите содержимое upload/ — index.html, assets/, wasm/, host/ (и bundles/, если нужны).
  3. Проверьте https://ваш-сайт/host/proxy.php?ping=1 — должен прийти JSON "ok": true.
  4. Откройте сайт и нажмите «Проверить» в блоке «Прокси для чужих серверов».`);
