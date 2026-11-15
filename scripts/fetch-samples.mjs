import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Downloads a few real bundles for local testing into public/bundles/.
 * They are copyrighted game assets, so decide yourself whether to commit them.
 *
 * Usage:
 *   npm run samples
 *   npm run samples -- itemicons ui sounds
 */

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, "..", "public", "bundles");
const source = "https://blockade3d.com/ClassicBundles";

const requested = process.argv.slice(2);
const names = requested.length ? requested : ["itemicons", "ui", "sounds"];

await mkdir(output, { recursive: true });

for (const name of names) {
  const file = name.endsWith(".webp") ? name : `${name}.webp`;
  const url = `${source}/${file}`;
  process.stdout.write(`${file} … `);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.log(`HTTP ${response.status}`);
      continue;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(join(output, file), bytes);
    console.log(`${(bytes.byteLength / 1024 / 1024).toFixed(2)} МБ`);
  } catch (error) {
    console.log(`ошибка: ${error.message}`);
  }
}

console.log(`\nГотово. Файлы лежат в ${output}`);
