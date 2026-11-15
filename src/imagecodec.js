import { zlibSync } from "fflate";

/* ---------------------------------------------------------------- */
/* PNG encoding (fallback for browsers without OffscreenCanvas)      */
/* ---------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode tight RGBA8 pixels to a PNG byte array. Rows are top-first. */
export function encodePNG(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 0; // filter: none
    raw.set(rgba.subarray(src, src + stride), dst + 1);
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlibSync(raw, { level: 6 });
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];

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

/* ---------------------------------------------------------------- */
/* Scaling                                                           */
/* ---------------------------------------------------------------- */

/**
 * Box-filter downscale. Only used when OffscreenCanvas is unavailable,
 * so keep it simple and branch-free in the inner loop.
 */
export function resizeRGBA(rgba, width, height, outWidth, outHeight) {
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

/* ---------------------------------------------------------------- */
/* PNG blob                                                          */
/* ---------------------------------------------------------------- */

function hasOffscreenCanvas() {
  return typeof OffscreenCanvas === "function";
}

function targetSize(width, height, maxSize) {
  if (!maxSize || maxSize <= 0) return [width, height];
  const scale = Math.min(1, maxSize / Math.max(width, height));
  if (scale >= 1) return [width, height];
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/**
 * Convert decoded RGBA pixels into a PNG Blob, optionally scaled down
 * so that neither side exceeds `maxSize`.
 */
export async function pngBlob(rgba, width, height, maxSize = 0) {
  const [outWidth, outHeight] = targetSize(width, height, maxSize);

  if (hasOffscreenCanvas()) {
    try {
      const source = new OffscreenCanvas(width, height);
      const sourceCtx = source.getContext("2d", { alpha: true });
      const pixels = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
      sourceCtx.putImageData(new ImageData(pixels, width, height), 0, 0);

      if (outWidth === width && outHeight === height) {
        return await source.convertToBlob({ type: "image/png" });
      }

      const target = new OffscreenCanvas(outWidth, outHeight);
      const targetCtx = target.getContext("2d", { alpha: true });
      targetCtx.imageSmoothingEnabled = true;
      targetCtx.imageSmoothingQuality = "high";
      targetCtx.drawImage(source, 0, 0, outWidth, outHeight);
      return await target.convertToBlob({ type: "image/png" });
    } catch {
      // fall through to the pure-JS path
    }
  }

  const scaled = resizeRGBA(rgba, width, height, outWidth, outHeight);
  return new Blob([encodePNG(scaled, outWidth, outHeight)], { type: "image/png" });
}

/* ---------------------------------------------------------------- */
/* Audio sniffing                                                    */
/* ---------------------------------------------------------------- */

function ascii(bytes, start, end) {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Guess a browser-friendly MIME type and file extension from raw audio bytes. */
export function sniffAudio(bytes) {
  if (!bytes || bytes.length < 4) return { mime: "application/octet-stream", ext: "bin", playable: false };

  const tag = ascii(bytes, 0, 4);
  if (tag === "OggS") return { mime: "audio/ogg", ext: "ogg", playable: true };
  if (tag === "RIFF") return { mime: "audio/wav", ext: "wav", playable: true };
  if (tag === "fLaC") return { mime: "audio/flac", ext: "flac", playable: true };
  if (tag === "FSB5") return { mime: "application/octet-stream", ext: "fsb", playable: false };
  if (bytes.length >= 8 && ascii(bytes, 4, 8) === "ftyp") {
    return { mime: "audio/mp4", ext: "m4a", playable: true };
  }
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return { mime: "audio/mpeg", ext: "mp3", playable: true };
  }
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return { mime: "audio/mpeg", ext: "mp3", playable: true };
  }
  return { mime: "application/octet-stream", ext: "bin", playable: false };
}

/** Filesystem-safe name without an extension. */
export function safeBaseName(name) {
  return String(name || "asset")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 120) || "asset";
}
