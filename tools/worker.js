/*
 * Воркер просмотрщика: разбирает UnityFS-бандл и декодирует текстуры.
 *
 * Собирается в Github/viewer-worker.js командой:
 *   esbuild tools/worker.js --bundle --format=esm --minify --target=es2020 \
 *     --outfile=Github/viewer-worker.js
 *
 * Сообщения (postMessage):
 *   {type:"load",  id, name, data: ArrayBuffer}
 *   {type:"image", id, pid, max}   — PNG-превью, max = ограничение стороны
 *   {type:"audio", id, pid}
 *   {type:"text",  id, pid}
 */

import { load, textAssetString } from "unity-asset-reader";
import { isImage, imageInfo, decodeImage, initTexture } from "unity-asset-reader-texture";
import { zlibSync } from "fflate";

let assetsByPid = new Map();
let textureReady = null;
let wasmPath = new URL("wasm/", self.location.href).href;

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message) return;
  const id = message.id;
  handle(message).catch((error) => {
    self.postMessage({ type: "error", id, message: (error && error.message) || String(error) });
  });
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
    default:
      throw new Error("Неизвестная команда: " + message.type);
  }
}

/* ------------------------------------------------------------------ */
/* разбор бандла                                                       */
/* ------------------------------------------------------------------ */

function loadBundle(message) {
  const started = performance.now();
  wasmPath = message.wasmPath || wasmPath;

  const bytes = new Uint8Array(message.data);
  const env = load([{ name: message.name || "bundle", data: bytes }]);

  assetsByPid = new Map();
  const list = [];
  let objects = 0;

  for (const asset of env.assets()) {
    objects += 1;

    let type = "Unknown";
    try {
      type = asset.type === "Other" ? asset.typeName || "Other" : asset.type || "Unknown";
    } catch (error) {
      type = "Unknown";
    }

    if (type === "AssetBundle" || type === "AssetBundleManifest") continue;

    const meta = describeAsset(asset, type);
    assetsByPid.set(meta.pid, asset);
    list.push(meta);
  }

  self.postMessage({
    type: "loaded",
    id: message.id,
    info: {
      name: message.name || "bundle",
      objects,
      total: list.length,
      bytes: bytes.byteLength,
      parseMs: Math.round(performance.now() - started),
    },
    assets: list,
  });
}

function describeAsset(asset, type) {
  const meta = {
    pid: "",
    name: "",
    type,
    path: "",
    bytes: 0,
    preview: "",
    width: 0,
    height: 0,
    format: "",
    error: "",
  };

  try {
    meta.pid = String(asset.pathId);
  } catch (error) {
    meta.pid = String(Math.random());
  }
  try {
    meta.name = String(asset.name || "");
  } catch (error) {
    meta.name = "";
  }
  if (!meta.name) meta.name = "object_" + meta.pid;
  try {
    meta.path = String(asset.path || "");
  } catch (error) {
    meta.path = "";
  }
  try {
    meta.bytes = Number(asset.byteSize) || 0;
  } catch (error) {
    meta.bytes = 0;
  }

  try {
    if (isImage(asset)) {
      const info = imageInfo(asset);
      meta.preview = "image";
      meta.width = info.width || 0;
      meta.height = info.height || 0;
      meta.format = info.formatName || "";
      meta.bytes = info.encodedSize || meta.bytes;
      return meta;
    }
    if (type === "AudioClip") {
      meta.preview = "audio";
      return meta;
    }
    if (type === "TextAsset") {
      meta.preview = "text";
      return meta;
    }
  } catch (error) {
    meta.error = (error && error.message) || String(error);
  }

  return meta;
}

/* ------------------------------------------------------------------ */
/* текстуры                                                            */
/* ------------------------------------------------------------------ */

function ensureTexture() {
  if (!textureReady) {
    textureReady = initTexture(wasmPath ? { wasmPath } : undefined).catch((error) => {
      textureReady = null;
      throw new Error("WASM-декодер не загрузился: " + error.message);
    });
  }
  return textureReady;
}

async function sendImage(message) {
  const asset = assetsByPid.get(String(message.pid));
  if (!asset) throw new Error("Объект не найден в бандле");

  await ensureTexture();
  const image = await decodeImage(asset, wasmPath ? { wasmPath } : undefined);
  const blob = await pngBlob(image.rgba, image.width, image.height, Math.max(0, Math.floor(Number(message.max) || 0)));

  self.postMessage({
    type: "image",
    id: message.id,
    blob,
    width: image.width,
    height: image.height,
    format: image.formatName || "",
  });
}

/* ------------------------------------------------------------------ */
/* аудио и текст                                                       */
/* ------------------------------------------------------------------ */

function ascii(bytes, start, end) {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function sniffAudio(bytes) {
  if (!bytes || bytes.length < 4) return { mime: "application/octet-stream", ext: "bin", playable: false };
  const tag = ascii(bytes, 0, 4);
  if (tag === "OggS") return { mime: "audio/ogg", ext: "ogg", playable: true };
  if (tag === "RIFF") return { mime: "audio/wav", ext: "wav", playable: true };
  if (tag === "fLaC") return { mime: "audio/flac", ext: "flac", playable: true };
  if (tag === "FSB5") return { mime: "application/octet-stream", ext: "fsb", playable: false };
  if (bytes.length >= 8 && ascii(bytes, 4, 8) === "ftyp") return { mime: "audio/mp4", ext: "m4a", playable: true };
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return { mime: "audio/mpeg", ext: "mp3", playable: true };
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return { mime: "audio/mpeg", ext: "mp3", playable: true };
  return { mime: "application/octet-stream", ext: "bin", playable: false };
}

function sendAudio(message) {
  const asset = assetsByPid.get(String(message.pid));
  if (!asset) throw new Error("Объект не найден в бандле");

  const raw = asset.data && asset.data.audioData;
  if (!raw || !raw.byteLength) throw new Error("В этом AudioClip нет звуковых данных");

  const bytes = raw.slice();
  const info = sniffAudio(bytes);
  self.postMessage({
    type: "audio",
    id: message.id,
    blob: new Blob([bytes], { type: info.mime }),
    mime: info.mime,
    ext: info.ext,
    playable: info.playable,
  });
}

function sendText(message) {
  const asset = assetsByPid.get(String(message.pid));
  if (!asset) throw new Error("Объект не найден в бандле");

  const data = asset.data;
  let text = "";
  if (data && typeof data.text === "string") {
    text = data.text;
  } else {
    text = textAssetString(data);
  }

  const limit = 2000000;
  self.postMessage({
    type: "text",
    id: message.id,
    text: text.length > limit ? text.slice(0, limit) : text,
    truncated: text.length > limit,
  });
}

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePNG(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 0;
    raw.set(rgba.subarray(src, src + stride), dst + 1);
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const idat = zlibSync(raw, { level: 6 });
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))];

  let total = 0;
  for (const part of parts) total += part.length;
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function resizeRGBA(rgba, width, height, outWidth, outHeight) {
  if (outWidth === width && outHeight === height) return rgba;
  const out = new Uint8Array(outWidth * outHeight * 4);
  const xRatio = width / outWidth;
  const yRatio = height / outHeight;

  for (let y = 0; y < outHeight; y += 1) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.max(sy0 + 1, Math.min(height, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < outWidth; x += 1) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.max(sx0 + 1, Math.min(width, Math.floor((x + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        let index = (sy * width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx += 1, index += 4) {
          r += rgba[index];
          g += rgba[index + 1];
          b += rgba[index + 2];
          a += rgba[index + 3];
          count += 1;
        }
      }
      const target = (y * outWidth + x) * 4;
      out[target] = r / count;
      out[target + 1] = g / count;
      out[target + 2] = b / count;
      out[target + 3] = a / count;
    }
  }
  return out;
}

function targetSize(width, height, maxSize) {
  if (!maxSize || maxSize <= 0) return [width, height];
  const scale = Math.min(1, maxSize / Math.max(width, height));
  if (scale >= 1) return [width, height];
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

async function pngBlob(rgba, width, height, maxSize) {
  const outWidth = targetSize(width, height, maxSize)[0];
  const outHeight = targetSize(width, height, maxSize)[1];

  if (typeof OffscreenCanvas === "function") {
    try {
      const source = new OffscreenCanvas(width, height);
      const pixels = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
      source.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);

      if (outWidth === width && outHeight === height) {
        return await source.convertToBlob({ type: "image/png" });
      }

      const target = new OffscreenCanvas(outWidth, outHeight);
      const ctx = target.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, 0, 0, outWidth, outHeight);
      return await target.convertToBlob({ type: "image/png" });
    } catch (error) {
      /* fallback ниже */
    }
  }

  const scaled = resizeRGBA(rgba, width, height, outWidth, outHeight);
  return new Blob([encodePNG(scaled, outWidth, outHeight)], { type: "image/png" });
}
