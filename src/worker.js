import { load, textAssetString } from "unity-asset-reader";
import { isImage, imageInfo, decodeImage, initTexture } from "unity-asset-reader-texture";
import { zipSync } from "fflate";
import { pngBlob, sniffAudio, safeBaseName } from "./imagecodec.js";
import { proxiedUrl } from "./proxy.js";

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

let env = null;
let assetsByPid = new Map();
let assetList = [];
let bundleInfo = null;
let wasmPath = "";
let textureReady = null;
let queue = Promise.resolve();

const cancelled = new Set();
const aborters = new Map();
const pngCache = new Map();
let pngCacheBytes = 0;
const PNG_CACHE_LIMIT = 96 * 1024 * 1024;
const PNG_CACHE_ITEMS = 600;

const AUDIO_COMPRESSION = {
  0: "PCM",
  1: "Vorbis",
  2: "ADPCM",
  3: "MP3",
  4: "VAG",
  5: "HEVAG",
  6: "XMA",
  7: "AAC",
  8: "GCADPCM",
  9: "ATRAC9",
};

/* ------------------------------------------------------------------ */
/* messaging                                                           */
/* ------------------------------------------------------------------ */

function post(message, transfer) {
  self.postMessage(message, transfer || []);
}

function progress(id, phase, extra) {
  post({ type: "progress", id, phase, ...extra });
}

function fail(id, error) {
  if (error && error.name === "AbortError") {
    post({ id, cancelled: true, ok: false, message: "Отменено" });
    return;
  }
  post({
    id,
    type: "error",
    ok: false,
    name: (error && error.name) || "Error",
    message: (error && error.message) || String(error),
    hint: (error && error.hint) || "",
  });
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message) return;
  if (message.type === "cancel") {
    cancelled.add(message.id);
    const controller = aborters.get(message.id);
    if (controller) controller.abort();
    return;
  }

  const run = () => handle(message);
  queue = queue.then(run, run).catch((error) => fail(message && message.id, error));
});

async function handle(message) {
  switch (message.type) {
    case "load":
      return loadBundle(message);
    case "image":
      return sendImage(message);
    case "audio":
      return sendAudio(message);
    case "text":
      return sendText(message);
    case "zip":
      return sendZip(message);
    default:
      throw new Error(`Неизвестная команда: ${message.type}`);
  }
}

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

function readNullString(bytes, start) {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  return {
    value: new TextDecoder().decode(bytes.subarray(start, end)),
    next: Math.min(bytes.length, end + 1),
  };
}

/**
 * UnityFS header (format 7+):
 *   "UnityFS\0", uint32 format, string playerVersion, string unityRevision, ...
 * Unity 6 writes "5.x.x" as the player version and the real editor version
 * ("6000.3.5f2") into the revision field, so prefer the field that looks real.
 */
function readUnityVersion(bytes) {
  try {
    let offset = 0;
    while (offset < 8 && bytes[offset] !== 0) offset += 1;
    const signature = new TextDecoder().decode(bytes.subarray(0, offset));
    if (signature !== "UnityFS") return "";

    let cursor = 8 + 4; // skip the big-endian format version
    const player = readNullString(bytes, cursor);
    cursor = player.next;
    const revision = readNullString(bytes, cursor);
    const version = player.value;
    const rev = revision.value;

    const looksReal = (value) => /^\d+(\.\d+){2,}/.test(value) && !/\.x\./i.test(value);
    if (looksReal(version)) return version;
    if (looksReal(rev)) return rev;
    return version || rev;
  } catch {
    return "";
  }
}

function fileNameFromUrl(url) {
  try {
    const parsed = new URL(url, self.location.href);
    const segment = parsed.pathname.split("/").filter(Boolean).pop() || "bundle";
    return decodeURIComponent(segment);
  } catch {
    return "bundle";
  }
}

function stripBundleExtension(name) {
  return String(name || "").replace(/\.(webp|bundle|unity3d|assets|dat|bin)$/i, "") || "bundle";
}

/**
 * Unity bundles start with one of these signatures. Anything else (an HTML
 * 404 page, a Vite SPA fallback, a plain image) must be rejected loudly
 * instead of being parsed as an empty bundle.
 */
const BUNDLE_SIGNATURES = ["UnityFS", "UnityWeb", "UnityRaw", "UnityWebData1.0"];

function looksLikeBundle(bytes) {
  if (!bytes || bytes.length < 8) return false;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return true; // gzip wrapper
  const head = new TextDecoder().decode(bytes.subarray(0, 24));
  return BUNDLE_SIGNATURES.some((signature) => head.startsWith(signature));
}

async function fetchWithProgress(url, id, signal, proxy) {
  const origin = originOf(url);
  if (!origin || !blockedOrigins.has(origin)) {
    try {
      return await fetchBytes(url, id, signal);
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      if (error && error.name === "NetworkError" && origin) blockedOrigins.add(origin);
      if (!proxy || !shouldRetryViaProxy(url, error)) throw error;
      progress(id, "connect", { received: 0, total: 0, viaProxy: true });
      return await fetchBytes(proxiedUrl(proxy, url), id, signal, { viaProxy: true });
    }
  }

  if (!proxy || !canProxy(url)) {
    return await fetchBytes(url, id, signal);
  }
  // Этот домен уже один раз не отдал CORS — сразу идём через прокси.
  progress(id, "connect", { received: 0, total: 0, viaProxy: true });
  return await fetchBytes(proxiedUrl(proxy, url), id, signal, { viaProxy: true });
}

/**
 * Домены, которые уже отказали напрямую (CORS). Живёт в памяти воркера:
 * второй бандл с того же сервера качается через прокси без лишней попытки.
 */
const blockedOrigins = new Set();

function originOf(url) {
  try {
    return new URL(url, self.location.href).origin;
  } catch {
    return "";
  }
}

/** Прокси имеет смысл только для чужих http(s)-адресов. */
function canProxy(url) {
  try {
    const target = new URL(url, self.location.href);
    return /^https?:$/.test(target.protocol) && target.origin !== self.location.origin;
  } catch {
    return false;
  }
}

function shouldRetryViaProxy(url, error) {
  if (!canProxy(url)) return false;
  if (error.name === "NetworkError") return true;
  if (error.name === "HttpError") return error.status === 403 || error.status >= 500;
  return false;
}

async function fetchBytes(url, id, signal, options) {
  const opts = options || {};
  let response;
  try {
    response = await fetch(url, { signal, credentials: "same-origin" });
  } catch (error) {
    if (error && error.name === "AbortError") throw error;
    const wrapped = new Error(
      /Failed to fetch|NetworkError|Load failed/i.test(String(error && error.message))
        ? "Не удалось прочитать файл по ссылке"
        : String((error && error.message) || error)
    );
    wrapped.name = "NetworkError";
    wrapped.hint = opts.viaProxy
      ? "Прокси не смог скачать файл. Проверьте, что host/proxy.php доступен и что домен " +
        "внесён в PROXY_ALLOWED_HOSTS; диагностика — host/proxy.php?ping=1."
      : "Скорее всего, сервер не отдаёт CORS-заголовок Access-Control-Allow-Origin, " +
        "либо файл недоступен. Можно включить прокси (host/proxy.php) или скачать бандл " +
        "и открыть его кнопкой «Файл…» — локальные файлы читаются без ограничений.";
    throw wrapped;
  }

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    error.name = "HttpError";
    error.status = response.status;
    error.hint = opts.viaProxy
      ? response.status === 403
        ? "Прокси запретил этот адрес: домен не в белом списке (PROXY_ALLOWED_HOSTS) или неверный токен."
        : response.status === 502 || response.status === 400
          ? "Прокси не смог скачать файл с сервера игры. Откройте host/proxy.php?ping=1 — " +
            "там видно, включены ли cURL и запись в кэш."
          : "Прокси ответил ошибкой. Проверьте путь к host/proxy.php на сервере."
      : response.status === 404
        ? "Файл не найден. Проверьте путь и имя файла (регистр важен)."
        : "Сервер ответил ошибкой. Проверьте ссылку и доступность файла.";
    throw error;
  }

  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = await response.arrayBuffer();
    progress(id, "download", { received: buffer.byteLength, total: buffer.byteLength || total });
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReport = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const now = performance.now();
    if (now - lastReport > 80) {
      lastReport = now;
      progress(id, "download", { received, total });
    }
  }

  progress(id, "download", { received, total: total || received });
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function loadBundle(message) {
  const started = performance.now();
  wasmPath = message.wasmPath || wasmPath;
  cancelled.delete(message.id);

  const controller = new AbortController();
  aborters.set(message.id, controller);

  try {
    let inputs;
    let label;

    if (message.url) {
      progress(message.id, "connect", { received: 0, total: 0 });
      const bytes = await fetchWithProgress(message.url, message.id, controller.signal, message.proxy);
      label = fileNameFromUrl(message.url);
      inputs = [{ name: label, data: bytes }];
      progress(message.id, "parse", { received: bytes.length, total: bytes.length });
    } else if (Array.isArray(message.files) && message.files.length) {
      inputs = message.files.map((file, index) => {
        const name = file.name || `input ${index}`;
        const data = new Uint8Array(file.data);
        return { name, data };
      });
      label = inputs[0].name;
      progress(message.id, "parse", { received: 0, total: 0 });
    } else {
      throw new Error("Не переданы данные бандла");
    }

    const version = readUnityVersion(inputs[0].data);

    if (!inputs.some((file) => looksLikeBundle(file.data))) {
      const error = new Error("Файл не похож на Unity AssetBundle");
      error.name = "FormatError";
      error.hint =
        "Первые байты не совпадают с сигнатурой UnityFS / UnityWeb. " +
        "Вероятно, сервер вернул HTML-страницу (404 или SPA-фолбэк) либо это посторонний файл.";
      throw error;
    }

    env = load(inputs.length === 1 ? inputs[0] : inputs);
    textureReady = null;
    pngCache.clear();
    pngCacheBytes = 0;
    assetsByPid = new Map();
    assetList = [];

    const typeCounts = new Map();
    let bundleName = "";
    let objects = 0;

    for (const asset of env.assets()) {
      objects += 1;
      let type;
      try {
        type = asset.type === "Other" ? asset.typeName || "Other" : asset.type || "Unknown";
      } catch {
        type = "Unknown";
      }

      if (type === "AssetBundle") {
        if (!bundleName) {
          try {
            bundleName = String(asset.name || "");
          } catch {
            /* ignore */
          }
        }
        continue;
      }
      if (type === "AssetBundleManifest") continue;

      const meta = describeAsset(asset, type);
      assetList.push(meta);
      assetsByPid.set(meta.pid, asset);
      typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
    }

    if (!bundleName) bundleName = stripBundleExtension(label);

    const types = [...typeCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

    bundleInfo = {
      bundle: bundleName,
      label,
      unityVersion: version,
      bytes: inputs.reduce((sum, file) => sum + file.data.byteLength, 0),
      objects,
      total: assetList.length,
      types,
      parseMs: performance.now() - started,
    };

    post({
      type: "loaded",
      id: message.id,
      ok: true,
      bundle: bundleInfo,
      assets: assetList,
    });
  } finally {
    aborters.delete(message.id);
  }
}

function describeAsset(asset, type) {
  const meta = {
    pid: "",
    name: "",
    type,
    path: "",
    bytes: 0,
    preview: null,
    error: "",
  };

  try {
    meta.pid = String(asset.pathId);
  } catch {
    meta.pid = `${Math.random()}`;
  }
  try {
    meta.name = String(asset.name || "");
  } catch {
    meta.name = "";
  }
  if (!meta.name) meta.name = `object_${meta.pid}`;
  try {
    meta.path = asset.path || "";
  } catch {
    meta.path = "";
  }
  try {
    meta.bytes = Number(asset.byteSize) || 0;
  } catch {
    meta.bytes = 0;
  }

  try {
    if (isImage(asset)) {
      const info = imageInfo(asset);
      meta.preview = "image";
      meta.kind = info.kind;
      meta.width = info.width;
      meta.height = info.height;
      meta.format = info.formatName || `#${info.format}`;
      meta.compression = info.compression;
      meta.mipCount = info.mipCount;
      meta.colorSpace = info.colorSpace;
      meta.bytes = info.encodedSize || meta.bytes;
      return meta;
    }

    if (type === "AudioClip") {
      const data = asset.data;
      meta.preview = "audio";
      meta.duration = Number(data.length) || 0;
      meta.channels = data.channels;
      meta.frequency = data.frequency;
      meta.compressionFormat = AUDIO_COMPRESSION[data.compressionFormat] || `#${data.compressionFormat}`;
      meta.bytes = data.audioData ? data.audioData.byteLength : meta.bytes;
      return meta;
    }

    if (type === "TextAsset") {
      const data = asset.data;
      meta.preview = "text";
      meta.bytes = data.bytes ? data.bytes.byteLength : meta.bytes;
      meta.textLength = typeof data.text === "string" ? data.text.length : 0;
      return meta;
    }
  } catch (error) {
    meta.error = (error && error.message) || String(error);
  }

  return meta;
}

/* ------------------------------------------------------------------ */
/* texture decoding                                                    */
/* ------------------------------------------------------------------ */

function getAsset(pid) {
  const asset = assetsByPid.get(String(pid));
  if (!asset) throw new Error("Объект не найден в текущем бандле");
  return asset;
}

async function ensureTexture() {
  if (!textureReady) {
    textureReady = initTexture(wasmPath ? { wasmPath } : undefined).catch((error) => {
      textureReady = null;
      const wrapped = new Error(`Не удалось загрузить WASM-декодер: ${error.message}`);
      wrapped.hint = "Проверьте, что файлы из public/wasm скопированы рядом с сайтом.";
      throw wrapped;
    });
  }
  return textureReady;
}

function cacheLookup(key) {
  const entry = pngCache.get(key);
  if (!entry) return null;
  // refresh LRU position
  pngCache.delete(key);
  pngCache.set(key, entry);
  return entry.blob;
}

function cacheStore(key, blob) {
  if (pngCache.has(key)) {
    const old = pngCache.get(key);
    pngCacheBytes -= old.size;
    pngCache.delete(key);
  }
  pngCache.set(key, { blob, size: blob.size });
  pngCacheBytes += blob.size;
  while (pngCache.size > PNG_CACHE_ITEMS || pngCacheBytes > PNG_CACHE_LIMIT) {
    const first = pngCache.keys().next();
    if (first.done) break;
    const old = pngCache.get(first.value);
    pngCacheBytes -= old.size;
    pngCache.delete(first.value);
  }
}

async function sendImage(message) {
  const pid = String(message.pid);
  const max = Math.max(0, Math.floor(Number(message.max) || 0));
  const key = `${pid}|${max}`;

  const cached = cacheLookup(key);
  if (cached) {
    post({ type: "image", id: message.id, ok: true, blob: cached, cached: true });
    return;
  }

  const asset = getAsset(pid);
  await ensureTexture();
  const image = await decodeImage(asset, wasmPath ? { wasmPath } : undefined);
  const blob = await pngBlob(image.rgba, image.width, image.height, max);
  cacheStore(key, blob);
  post({
    type: "image",
    id: message.id,
    ok: true,
    blob,
    width: image.width,
    height: image.height,
    format: image.formatName,
    compression: image.compression,
  });
}

/* ------------------------------------------------------------------ */
/* audio / text                                                        */
/* ------------------------------------------------------------------ */

async function sendAudio(message) {
  const asset = getAsset(message.pid);
  const data = asset.data;
  const raw = data.audioData;
  if (!raw || !raw.byteLength) throw new Error("В этом AudioClip нет звуковых данных");

  const bytes = raw.slice();
  const info = sniffAudio(bytes);
  post({
    type: "audio",
    id: message.id,
    ok: true,
    blob: new Blob([bytes], { type: info.mime }),
    mime: info.mime,
    ext: info.ext,
    playable: info.playable,
    size: bytes.byteLength,
    name: data.name || asset.name || "audio",
  });
}

function textOf(data) {
  if (data && typeof data.text === "string") return data.text;
  return textAssetString(data);
}

async function sendText(message) {
  const asset = getAsset(message.pid);
  const text = textOf(asset.data);
  const limit = 2_000_000;
  const truncated = text.length > limit;
  post({
    type: "text",
    id: message.id,
    ok: true,
    text: truncated ? text.slice(0, limit) : text,
    truncated,
    size: text.length,
  });
}

/* ------------------------------------------------------------------ */
/* ZIP export                                                          */
/* ------------------------------------------------------------------ */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function uniqueName(used, base) {
  const clean = safeBaseName(base);
  if (!used.has(clean)) {
    used.add(clean);
    return clean;
  }
  let index = 2;
  while (used.has(`${clean}-${index}`)) index += 1;
  const name = `${clean}-${index}`;
  used.add(name);
  return name;
}

async function sendZip(message) {
  const id = message.id;
  cancelled.delete(id);
  await ensureTexture();

  const files = {};
  const used = new Set();
  const errors = [];
  const total = assetList.length;
  let done = 0;

  for (const meta of assetList) {
    if (cancelled.has(id)) {
      const error = new Error("Экспорт отменён");
      error.name = "AbortError";
      throw error;
    }

    try {
      if (meta.preview === "image") {
        const asset = getAsset(meta.pid);
        const image = await decodeImage(asset, wasmPath ? { wasmPath } : undefined);
        const blob = await pngBlob(image.rgba, image.width, image.height, 0);
        const buffer = new Uint8Array(await blob.arrayBuffer());
        files[uniqueName(used, `${meta.name}.png`)] = buffer;
      } else if (meta.preview === "audio") {
        const asset = getAsset(meta.pid);
        const raw = asset.data.audioData;
        if (raw && raw.byteLength) {
          const info = sniffAudio(raw);
          files[uniqueName(used, `${meta.name}.${info.ext}`)] = raw.slice();
        }
      } else if (meta.preview === "text") {
        const asset = getAsset(meta.pid);
        const text = textOf(asset.data);
        files[uniqueName(used, `${meta.name}.txt`)] = new TextEncoder().encode(text);
      }
    } catch (error) {
      errors.push(`${meta.name}: ${(error && error.message) || error}`);
    }

    done += 1;
    if (done % 5 === 0 || done === total) {
      progress(id, "zip", { done, total });
    }
    if (done % 12 === 0) await tick();
  }

  const info = {
    bundle: bundleInfo && bundleInfo.bundle,
    unityVersion: bundleInfo && bundleInfo.unityVersion,
    exportedAt: new Date().toISOString(),
    objects: total,
    files: Object.keys(files).length,
    errors,
  };
  files["_bundle-info.json"] = new TextEncoder().encode(JSON.stringify(info, null, 2));

  progress(id, "zip-pack", { done: total, total });
  await tick();
  const zipped = zipSync(files, { level: 4 });
  const blob = new Blob([zipped], { type: "application/zip" });
  post({
    type: "zip",
    id,
    ok: true,
    blob,
    size: blob.size,
    files: Object.keys(files).length,
    errors,
  });
}
