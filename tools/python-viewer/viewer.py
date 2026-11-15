#!/usr/bin/env python3
"""
viewer.py - Unity AssetBundle viewer that reads bundles straight from a URL
(or a local file / drag & drop) into memory and renders assets in the browser.

The bundle is never written to disk: it is downloaded into RAM, parsed with
UnityPy and cached only in memory.

Requirements: UnityPy, Pillow, requests
Run:          python viewer.py
Open:         http://127.0.0.1:8765/
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import threading
import time
import uuid
import webbrowser
import zipfile
from collections import Counter, OrderedDict
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

import requests
import UnityPy
from PIL import Image
from UnityPy.enums import TextureFormat

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"

DEFAULT_SRC = "https://blockade3d.com/ClassicBundles/itemicons.webp"
DEFAULT_BASE = "https://blockade3d.com/ClassicBundles/"

# Bundle names shipped with BLOCKADE (used by the "scan version" button).
KNOWN_BUNDLES = [
    "itemicons", "ui", "hud", "atlases", "zoomtextures", "player_skins",
    "actions", "flags", "quest", "sounds", "generic_sounds", "soundtrack",
    "maintheme", "season1", "season2", "season3", "season4",
    "heavy_tank_data", "medium_tank_data", "light_tank_data",
    "helicopter_data", "jeep_data", "unifiedraytracing", "Windows",
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

CACHE_MAX_BYTES = 768 * 1024 * 1024
CACHE_MAX_ENTRIES = 8
UPLOAD_MAX_BYTES = 512 * 1024 * 1024
EXPORT_MAX_BYTES = 512 * 1024 * 1024

AUDIO_MIME = {
    ".m4a": "audio/mp4", ".aac": "audio/aac", ".mp3": "audio/mpeg",
    ".wav": "audio/wav", ".ogg": "audio/ogg", ".fsb": "application/octet-stream",
}

IMAGE_TYPES = {"Texture2D", "Sprite"}
TEXT_TYPES = {"TextAsset"}

_safe_chars = re.compile(r"[^0-9A-Za-z._-]+")


def sanitize(name: str, fallback: str = "asset") -> str:
    name = _safe_chars.sub("_", (name or "").strip()).strip("._")
    return name[:120] or fallback


def fmt_name(value) -> str:
    if isinstance(value, int) and not isinstance(value, bool):
        try:
            return TextureFormat(value).name
        except ValueError:
            return str(value)
    name = getattr(value, "name", None)
    if isinstance(name, str):
        return name
    return str(value)


def human_name(o) -> str:
    try:
        name = o.peek_name()
        if name:
            return name
    except Exception:
        pass
    try:
        name = getattr(o.read(), "m_Name", "")
        if name:
            return name
    except Exception:
        pass
    return ""


class Entry:
    """One parsed bundle kept in memory."""

    __slots__ = ("src", "label", "data_size", "env", "assets", "by_pid",
                 "readers", "types", "unity_version", "bundle_name",
                 "parse_seconds", "lock", "thumbs")

    def __init__(self, src, label, data_size, env, assets, readers, types,
                 unity_version, bundle_name, parse_seconds):
        self.src = src
        self.label = label
        self.data_size = data_size
        self.env = env
        self.assets = assets
        self.by_pid = {a["pid"]: a for a in assets}
        self.readers = readers
        self.types = types
        self.unity_version = unity_version
        self.bundle_name = bundle_name
        self.parse_seconds = parse_seconds
        self.lock = threading.Lock()
        self.thumbs = OrderedDict()

    def info(self) -> dict:
        return {
            "src": self.src,
            "label": self.label,
            "bundle": self.bundle_name,
            "unity_version": self.unity_version,
            "bytes": self.data_size,
            "parse_seconds": round(self.parse_seconds, 2),
            "total": len(self.assets),
            "types": [{"type": t, "count": c} for t, c in self.types.most_common()],
            "assets": self.assets,
        }


ENTRIES: "OrderedDict[str, Entry]" = OrderedDict()
ENTRIES_LOCK = threading.RLock()
ENTRIES_BYTES = 0
PARSE_LOCK = threading.Lock()

UPLOADS: "OrderedDict[str, tuple[str, bytes]]" = OrderedDict()
UPLOADS_LOCK = threading.Lock()

PROBE_CACHE: dict[str, tuple[float, list]] = {}
PROBE_LOCK = threading.Lock()


# --------------------------------------------------------------------------- #
# Source loading
# --------------------------------------------------------------------------- #

def source_label(src: str) -> str:
    if src.startswith("upload:"):
        with UPLOADS_LOCK:
            item = UPLOADS.get(src)
        return item[0] if item else "upload"
    if src.lower().startswith("file:"):
        return os.path.basename(local_path(src))
    if src.startswith(("http://", "https://")):
        path = urlparse(src).path.rstrip("/")
        return os.path.basename(path) or urlparse(src).netloc
    return os.path.basename(src) or src


def local_path(src: str) -> str:
    if src.lower().startswith("file:"):
        parsed = urlparse(src)
        path = unquote(parsed.path)
        if parsed.netloc:
            path = f"//{parsed.netloc}{path}"
        if os.name == "nt" and re.match(r"^/[A-Za-z]:", path):
            path = path[1:]
        return path
    return src


def read_source(src: str) -> bytes:
    if src.startswith("upload:"):
        with UPLOADS_LOCK:
            item = UPLOADS.get(src)
        if not item:
            raise RuntimeError("загруженный файл уже выгружен из памяти, загрузите заново")
        return item[1]
    if src.startswith(("http://", "https://")):
        resp = requests.get(src, headers={"User-Agent": UA, "Accept": "*/*"},
                            timeout=(20, 300))
        resp.raise_for_status()
        return resp.content
    path = local_path(src)
    if not os.path.isfile(path):
        raise RuntimeError(f"файл не найден: {path}")
    with open(path, "rb") as fh:
        return fh.read()


def parse_bundle(src: str, data: bytes) -> Entry:
    started = time.perf_counter()
    env = UnityPy.load(data)
    unity_version = ""
    label = source_label(src)
    bundle_name = label

    for bundle_file in env.files.values():
        for serialized in getattr(bundle_file, "files", {}).values():
            version = getattr(serialized, "unity_version", "") or ""
            if version:
                unity_version = version
        if not unity_version:
            version = (getattr(bundle_file, "unity_version", "")
                       or getattr(bundle_file, "version_engine", "") or "")
            if version:
                unity_version = version

    assets: list[dict] = []
    types: Counter = Counter()
    readers: dict[int, object] = {}

    for o in env.objects:
        try:
            type_name = o.type.name
        except Exception:
            type_name = f"ClassID_{getattr(o, 'class_id', '?')}"

        if type_name == "AssetBundle":
            try:
                bundle_name = getattr(o.read(), "m_AssetBundleName", "") or bundle_name
            except Exception:
                pass
            continue

        name = human_name(o) or f"{type_name}_{o.path_id}"
        asset = {
            "pid": str(o.path_id),
            "name": name,
            "type": type_name,
            "bytes": getattr(o, "byte_size", 0) or 0,
            "preview": ("image" if type_name in IMAGE_TYPES else
                        "audio" if type_name == "AudioClip" else
                        "text" if type_name in TEXT_TYPES else "none"),
        }

        if type_name == "Texture2D":
            try:
                tex = o.read()
                asset["w"] = getattr(tex, "m_Width", None)
                asset["h"] = getattr(tex, "m_Height", None)
                asset["format"] = fmt_name(getattr(tex, "m_TextureFormat", ""))
            except Exception as exc:
                asset["error"] = f"не читается: {exc}"
        elif type_name == "Sprite":
            try:
                sprite = o.read()
                rect = getattr(sprite, "m_Rect", None)
                if rect is not None:
                    asset["w"] = round(getattr(rect, "width", 0)) or None
                    asset["h"] = round(getattr(rect, "height", 0)) or None
            except Exception:
                pass

        types[type_name] += 1
        readers[str(o.path_id)] = o
        assets.append(asset)

    parse_seconds = time.perf_counter() - started
    return Entry(src, label, len(data), env, assets, readers, types,
                 unity_version or "?", bundle_name, parse_seconds)


def get_entry(src: str, refresh: bool = False) -> Entry:
    global ENTRIES_BYTES

    with ENTRIES_LOCK:
        entry = ENTRIES.get(src)
        if entry and not refresh:
            ENTRIES.move_to_end(src)
            return entry

    with PARSE_LOCK:
        with ENTRIES_LOCK:
            entry = ENTRIES.get(src)
            if entry and not refresh:
                ENTRIES.move_to_end(src)
                return entry

        data = read_source(src)
        entry = parse_bundle(src, data)

        with ENTRIES_LOCK:
            old = ENTRIES.pop(src, None)
            if old:
                ENTRIES_BYTES -= old.data_size
            ENTRIES[src] = entry
            ENTRIES_BYTES += entry.data_size
            while len(ENTRIES) > 1 and (
                    len(ENTRIES) > CACHE_MAX_ENTRIES or ENTRIES_BYTES > CACHE_MAX_BYTES):
                _, dropped = ENTRIES.popitem(last=False)
                ENTRIES_BYTES -= dropped.data_size
        return entry


# --------------------------------------------------------------------------- #
# Asset rendering
# --------------------------------------------------------------------------- #

def render_asset(entry: Entry, asset: dict, mode: str, width: int):
    """Return (bytes, mime, filename)."""
    obj = entry.readers.get(asset["pid"])
    if obj is None:
        raise RuntimeError("объект не найден")

    type_name = asset["type"]

    if mode == "raw":
        with entry.lock:
            payload = obj.get_raw_data()
        return payload, "application/octet-stream", sanitize(asset["name"]) + ".raw"

    if type_name in IMAGE_TYPES:
        with entry.lock:
            image = obj.read().image
        if image is None:
            raise RuntimeError("не удалось декодировать текстуру")
        if mode == "thumb":
            image.thumbnail((width, width), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue(), "image/png", sanitize(asset["name"]) + ".png"

    if type_name == "AudioClip":
        with entry.lock:
            samples = obj.read().samples or {}
        if not samples:
            raise RuntimeError("в клипе нет сэмплов")
        filename, payload = next(iter(samples.items()))
        ext = os.path.splitext(filename)[1].lower()
        return payload, AUDIO_MIME.get(ext, "application/octet-stream"), sanitize(filename)

    if type_name in TEXT_TYPES:
        text = None
        with entry.lock:
            try:
                text = getattr(obj.read(), "m_Script", None)
            except Exception:
                text = None
            if text is None:
                try:
                    text = obj.read_typetree().get("m_Script")
                except Exception:
                    text = None
        if isinstance(text, (bytes, bytearray)):
            text = bytes(text).decode("utf-8", "replace")
        if text is None:
            raise RuntimeError("этот TextAsset не содержит текста")
        return text.encode("utf-8"), "text/plain; charset=utf-8", sanitize(asset["name"]) + ".txt"

    raise RuntimeError(f"предпросмотр для типа {type_name} не поддерживается")


def thumbnail(entry: Entry, asset: dict, width: int) -> bytes:
    key = (asset["pid"], width)
    with entry.lock:
        payload = entry.thumbs.get(key)
        if payload:
            entry.thumbs.move_to_end(key)
            return payload
    payload, _, _ = render_asset(entry, asset, "thumb", width)
    with entry.lock:
        entry.thumbs[key] = payload
        while len(entry.thumbs) > 4000:
            entry.thumbs.popitem(last=False)
    return payload


def build_zip(entry: Entry) -> tuple[bytes, str]:
    buf = io.BytesIO()
    used: set[str] = set()
    total = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:
        for asset in entry.assets:
            if asset["preview"] not in ("image", "audio", "text"):
                continue
            try:
                payload, _, filename = render_asset(entry, asset, "full", 0)
            except Exception:
                continue
            stem, ext = os.path.splitext(filename)
            candidate = filename
            index = 2
            while candidate in used:
                candidate = f"{stem}_{index}{ext}"
                index += 1
            used.add(candidate)
            total += len(payload)
            if total > EXPORT_MAX_BYTES:
                raise RuntimeError(
                    "бандл слишком большой для ZIP в памяти (>512 МБ). "
                    "Скачивайте ассеты по одному.")
            archive.writestr(candidate, payload)
    return buf.getvalue(), sanitize(entry.label) + ".zip"


# --------------------------------------------------------------------------- #
# HTTP server
# --------------------------------------------------------------------------- #

class Handler(BaseHTTPRequestHandler):
    server_version = "BundleViewer/1.0"
    protocol_version = "HTTP/1.1"

    # -- helpers ----------------------------------------------------------- #

    def log_message(self, fmt, *args):
        if getattr(self.server, "verbose", False):
            super().log_message(fmt, *args)

    def _host_ok(self) -> bool:
        if getattr(self.server, "allow_any_host", False):
            return True
        host = (self.headers.get("Host") or "").split(":")[0].strip("[]").lower()
        return host in ("127.0.0.1", "localhost", "::1", "")

    def _send(self, status: int, payload: bytes, mime: str,
              filename: str | None = None, cache: str = "no-store",
              extra: dict | None = None):
        start, end = 0, len(payload) - 1
        partial = False
        range_header = self.headers.get("Range")
        if range_header and payload:
            match = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if match:
                if match.group(1):
                    start = int(match.group(1))
                if match.group(2):
                    end = min(int(match.group(2)), len(payload) - 1)
                if start > end or start >= len(payload):
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{len(payload)}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                partial = True

        body = payload[start:end + 1]
        self.send_response(206 if partial else status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(payload)}")
            self.send_header("Accept-Ranges", "bytes")
        if filename:
            ascii_name = filename.encode("ascii", "ignore").decode() or "asset"
            self.send_header(
                "Content-Disposition",
                f"attachment; filename=\"{ascii_name}\"; "
                f"filename*=UTF-8''{quote(filename)}")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _error(self, status: int, message: str):
        self._json({"error": message}, status)

    @staticmethod
    def _q(query: dict, key: str, default: str = "") -> str:
        values = query.get(key)
        return values[0] if values else default

    # -- routing ----------------------------------------------------------- #

    def do_GET(self):
        if not self._host_ok():
            self._error(403, "forbidden host")
            return
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query, keep_blank_values=True)

        try:
            if path in ("/", "/index.html"):
                return self._serve_static("index.html")
            if path == "/api/list":
                return self.api_list(query)
            if path == "/api/asset":
                return self.api_asset(query)
            if path == "/api/export":
                return self.api_export(query)
            if path == "/api/probe":
                return self.api_probe(query)
            if path == "/api/config":
                return self._json({
                    "default_src": getattr(self.server, "default_src", DEFAULT_SRC),
                    "default_base": DEFAULT_BASE,
                    "bundles": KNOWN_BUNDLES,
                })
            if path == "/api/health":
                return self._json({"ok": True})
            if path.startswith("/static/"):
                return self._serve_static(path[len("/static/"):])
            self._error(404, "not found")
        except requests.HTTPError as exc:
            response = exc.response
            if response is not None:
                self._error(502, f"сервер вернул {response.status_code}: {response.url}")
            else:
                self._error(502, "сервер вернул ошибку")
        except requests.RequestException as exc:
            self._error(502, f"сеть: {exc}")
        except Exception as exc:  # noqa: BLE001 - surface the reason to the UI
            self._error(500, str(exc))

    def do_POST(self):
        if not self._host_ok():
            self._error(403, "forbidden host")
            return
        if urlparse(self.path).path != "/api/upload":
            self._error(404, "not found")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                raise RuntimeError("пустое тело запроса")
            if length > UPLOAD_MAX_BYTES:
                raise RuntimeError("файл больше 512 МБ")
            data = self.rfile.read(length)
            name = unquote(self.headers.get("X-Filename") or "upload.bundle")
            src = "upload:" + uuid.uuid4().hex
            with UPLOADS_LOCK:
                UPLOADS[src] = (name, data)
                while len(UPLOADS) > 4:
                    UPLOADS.popitem(last=False)
            self._json({"src": src, "label": name, "bytes": len(data)})
        except Exception as exc:  # noqa: BLE001
            self._error(400, str(exc))

    # -- static ------------------------------------------------------------ #

    def _serve_static(self, relative: str):
        root = STATIC_DIR.resolve()
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            return self._error(404, "not found")
        mime = {".html": "text/html; charset=utf-8",
                ".js": "application/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".svg": "image/svg+xml",
                ".png": "image/png",
                ".ico": "image/x-icon"}.get(candidate.suffix.lower(),
                                            "application/octet-stream")
        self._send(200, candidate.read_bytes(), mime, cache="no-cache")

    # -- API --------------------------------------------------------------- #

    def api_list(self, query):
        src = self._q(query, "src").strip()
        if not src:
            return self._error(400, "не указан src")
        refresh = self._q(query, "refresh") not in ("", "0")
        entry = get_entry(src, refresh=refresh)
        self._json(entry.info())

    def api_asset(self, query):
        src = self._q(query, "src").strip()
        pid_raw = self._q(query, "pid").strip()
        mode = self._q(query, "mode", "thumb")
        dl = self._q(query, "dl") not in ("", "0")
        if not src or not pid_raw:
            return self._error(400, "нужны src и pid")

        entry = get_entry(src)
        asset = entry.by_pid.get(pid_raw)
        if asset is None:
            try:
                asset = entry.by_pid.get(str(int(pid_raw)))
            except ValueError:
                asset = None
        if asset is None:
            return self._error(404, "ассет не найден")

        if mode == "thumb":
            width = max(16, min(1024, int(self._q(query, "w", "160") or 160)))
            payload = thumbnail(entry, asset, width)
            return self._send(200, payload, "image/png",
                              cache="private, max-age=3600")

        payload, mime, filename = render_asset(entry, asset, mode, 0)
        return self._send(200, payload, mime,
                          filename=filename if dl else None,
                          cache="private, max-age=600")

    def api_export(self, query):
        src = self._q(query, "src").strip()
        if not src:
            return self._error(400, "не указан src")
        entry = get_entry(src)
        payload, filename = build_zip(entry)
        self._send(200, payload, "application/zip", filename=filename)

    def api_probe(self, query):
        base = self._q(query, "base").strip() or DEFAULT_BASE
        if not base.endswith("/"):
            base += "/"
        names = [n.strip() for n in self._q(query, "names").split(",") if n.strip()]
        if not names:
            names = KNOWN_BUNDLES

        with PROBE_LOCK:
            cached = PROBE_CACHE.get(base)
            if cached and time.time() - cached[0] < 300:
                return self._json({"base": base, "bundles": cached[1]})

        def head(name: str):
            url = f"{base}{name}.webp"
            try:
                resp = requests.head(url, headers={"User-Agent": UA},
                                     timeout=15, allow_redirects=True)
                size = int(resp.headers.get("Content-Length") or 0)
                return {"name": name, "url": url, "ok": resp.status_code == 200,
                        "status": resp.status_code, "bytes": size}
            except requests.RequestException as exc:
                return {"name": name, "url": url, "ok": False, "status": 0,
                        "bytes": 0, "error": str(exc)[:160]}

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(head, names))
        results.sort(key=lambda item: (not item["ok"], item["name"]))
        with PROBE_LOCK:
            PROBE_CACHE[base] = (time.time(), results)
        self._json({"base": base, "bundles": results})


def main() -> None:
    parser = argparse.ArgumentParser(description="Unity AssetBundle web viewer")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="open the browser on start")
    parser.add_argument("--verbose", action="store_true", help="log every request")
    parser.add_argument("--default-src", default=DEFAULT_SRC,
                        help="bundle opened by default in the UI")
    args = parser.parse_args()

    if not STATIC_DIR.joinpath("index.html").is_file():
        raise SystemExit(f"static/index.html not found next to {__file__}")

    handler = Handler
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.daemon_threads = True
    server.verbose = args.verbose
    server.default_src = args.default_src
    server.allow_any_host = args.host not in ("127.0.0.1", "localhost", "::1")
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}/"

    print("Unity AssetBundle viewer")
    print(f"  UI:      {url}")
    print(f"  default: {args.default_src}")
    print("  bundles are parsed in memory only, nothing is written to disk")
    print("  Ctrl+C to stop")

    if args.open:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
