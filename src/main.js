import "./style.css";

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

const BUNDLES_BASE = new URL("bundles/", document.baseURI).href;
const WASM_PATH = new URL("wasm/", document.baseURI).href;

/**
 * Names used by BLOCKADE's ClassicBundles folder. They are only a fallback:
 * if `bundles/bundles.json` exists, its list wins.
 */
const KNOWN_BUNDLES = [
  "itemicons",
  "ui",
  "hud",
  "atlases",
  "zoomtextures",
  "player_skins",
  "actions",
  "flags",
  "quest",
  "sounds",
  "generic_sounds",
  "soundtrack",
  "maintheme",
  "season1",
  "season2",
  "season3",
  "season4",
  "unifiedraytracing",
];

const THUMB_CONCURRENCY = 4;
const FULL_CACHE_LIMIT = 8;

/* ------------------------------------------------------------------ */
/* dom                                                                 */
/* ------------------------------------------------------------------ */

const $ = (selector) => document.querySelector(selector);

const els = {
  progress: $("#progress"),
  progressFill: $("#progressFill"),
  status: $("#statusText"),
  src: $("#src"),
  open: $("#open"),
  scan: $("#scan"),
  base: $("#base"),
  pickFile: $("#pickFile"),
  emptyPick: $("#emptyPick"),
  emptyScan: $("#emptyScan"),
  file: $("#file"),
  chips: $("#chips"),
  errorBox: $("#errorBox"),
  errorText: $("#errorText"),
  errorHint: $("#errorHint"),
  errorClose: $("#errorClose"),
  info: $("#bundleInfo"),
  bundleName: $("#bundleName"),
  bundleMeta: $("#bundleMeta"),
  bundleLink: $("#bundleLink"),
  unityBadge: $("#unityBadge"),
  typeChips: $("#typeChips"),
  toolbar: $("#toolbar"),
  search: $("#search"),
  typeFilter: $("#typeFilter"),
  sort: $("#sort"),
  thumbSize: $("#thumbSize"),
  resultCount: $("#resultCount"),
  export: $("#export"),
  grid: $("#grid"),
  empty: $("#empty"),
  emptyTitle: $("#emptyTitle"),
  emptyNote: $("#emptyNote"),
  emptyActions: $("#emptyActions"),
  drop: $("#drop"),
  toast: $("#toast"),
  zipbar: $("#zipbar"),
  zipTitle: $("#zipTitle"),
  zipStatus: $("#zipStatus"),
  zipFill: $("#zipFill"),
  zipSave: $("#zipSave"),
  zipCancel: $("#zipCancel"),
  zipClose: $("#zipClose"),
  modal: $("#modal"),
  mTitle: $("#mTitle"),
  mSub: $("#mSub"),
  mStage: $("#mStage"),
  mMeta: $("#mMeta"),
  mPrev: $("#mPrev"),
  mNext: $("#mNext"),
  mClose: $("#mClose"),
  mDownload: $("#mDownload"),
  mCopy: $("#mCopy"),
  mPos: $("#mPos"),
};

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const state = {
  assets: [],
  types: [],
  view: [],
  bundle: null,
  src: "",
  query: "",
  type: "all",
  sort: "name",
  thumb: 176,
  current: null,
  loadToken: 0,
  scanToken: 0,
  generation: 0,
  busy: 0,
  modalToken: 0,
  zipId: null,
  pendingZip: null,
  thumbUrls: new Map(),
  thumbWaiters: new Map(),
  fullCache: new Map(),
  modalUrls: [],
  observer: null,
  cardMeta: new WeakMap(),
};

/* ------------------------------------------------------------------ */
/* worker bridge                                                       */
/* ------------------------------------------------------------------ */

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

let requestId = 0;
const pending = new Map();

class ViewerError extends Error {
  constructor(message, hint, name) {
    super(message);
    this.name = name || "ViewerError";
    this.hint = hint || "";
  }
}

function call(type, payload, options = {}) {
  requestId += 1;
  const id = requestId;
  if (options.onStart) options.onStart(id);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: options.onProgress });
    worker.postMessage({ type, ...payload, id }, options.transfer || []);
  });
}

worker.addEventListener("message", (event) => {
  const message = event.data;
  if (!message) return;

  if (message.type === "progress") {
    const entry = pending.get(message.id);
    if (entry && entry.onProgress) entry.onProgress(message);
    return;
  }

  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);

  if (message.ok) {
    entry.resolve(message);
  } else {
    entry.reject(new ViewerError(message.message || "Неизвестная ошибка", message.hint, message.name));
  }
});

worker.addEventListener("error", (event) => {
  toast("Воркер упал: " + (event.message || "неизвестная ошибка"));
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  if (seconds < 10) return `${seconds.toFixed(1)} с`;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props || {});
  for (const child of children) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function safeFileBase(name) {
  return String(name || "asset")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 120) || "asset";
}

let toastTimer = null;
function toast(message, ok = false) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle("ok", ok);
  els.toast.hidden = !message;
  if (message) {
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 6500);
  }
}

function showError(title, text, hint) {
  els.errorBox.hidden = false;
  els.errorText.textContent = text || "";
  els.errorHint.textContent = hint || "";
  const heading = els.errorBox.querySelector("strong");
  if (heading) heading.textContent = title || "Не удалось открыть бандл";
}

function hideError() {
  els.errorBox.hidden = true;
}

/* ------------------------------------------------------------------ */
/* progress                                                            */
/* ------------------------------------------------------------------ */

function beginWork(label) {
  state.busy += 1;
  els.progress.hidden = false;
  els.status.hidden = false;
  els.status.textContent = label || "Работаю…";
  els.progress.classList.remove("indeterminate");
  els.progressFill.style.width = "4%";
}

function endWork() {
  state.busy = Math.max(0, state.busy - 1);
  if (state.busy === 0) {
    els.progress.hidden = true;
    els.status.hidden = true;
    els.progress.classList.remove("indeterminate");
  }
}

function setProgress(percent, label, indeterminate = false) {
  els.progress.hidden = false;
  els.status.hidden = false;
  if (label) els.status.textContent = label;
  els.progress.classList.toggle("indeterminate", indeterminate);
  if (!indeterminate) {
    els.progressFill.style.width = `${Math.max(3, Math.min(100, percent || 0))}%`;
  }
}

function updateProgress(event) {
  if (event.phase === "connect") {
    setProgress(2, "Соединяюсь…", true);
  } else if (event.phase === "download") {
    const total = event.total || 0;
    const percent = total ? (event.received / total) * 100 : 0;
    const suffix = total
      ? `${formatBytes(event.received)} из ${formatBytes(total)} · ${Math.floor(percent)}%`
      : formatBytes(event.received);
    setProgress(percent, `Скачиваю бандл… ${suffix}`);
  } else if (event.phase === "parse") {
    setProgress(100, "Разбираю UnityFS…", true);
  }
}

/* ------------------------------------------------------------------ */
/* load result                                                         */
/* ------------------------------------------------------------------ */

function clearBundleCaches() {
  state.generation += 1;
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }
  for (const url of state.thumbUrls.values()) URL.revokeObjectURL(url);
  state.thumbUrls.clear();
  state.thumbWaiters.clear();
  thumbQueue.length = 0;
  state.cardMeta = new WeakMap();

  for (const url of state.fullCache.values()) URL.revokeObjectURL(url);
  state.fullCache.clear();
  clearModalTemp();
}

function clearModalTemp() {
  for (const url of state.modalUrls) URL.revokeObjectURL(url);
  state.modalUrls = [];
}

function applyLoaded(message, source, displayName) {
  clearBundleCaches();
  hideZipBar();
  hideError();

  state.bundle = message.bundle;
  state.assets = message.assets || [];
  state.types = message.bundle.types || [];
  state.src = source || "";
  state.query = "";
  state.type = "all";
  state.sort = "name";
  state.current = null;

  els.search.value = "";
  els.sort.value = "name";
  els.src.value = source || "";
  els.toolbar.hidden = false;
  els.info.hidden = false;

  renderInfo(displayName);
  renderTypeFilter();
  renderTypeChips();
  renderGrid();
  markActiveChip();

  document.title = `${message.bundle.bundle || "Bundle"} — Bundle Viewer`;
}

function renderInfo(displayName) {
  const bundle = state.bundle;
  if (!bundle) return;

  els.bundleName.textContent = bundle.bundle || displayName || "Bundle";
  const meta = [];
  if (bundle.unityVersion) meta.push(`Unity ${bundle.unityVersion}`);
  meta.push(`${bundle.total} ${plural(bundle.total, "ассет", "ассета", "ассетов")}`);
  meta.push(formatBytes(bundle.bytes));
  meta.push(`разбор ${(bundle.parseMs / 1000).toFixed(1)} с`);
  els.bundleMeta.textContent = meta.join("  ·  ");

  els.unityBadge.textContent = bundle.unityVersion ? `Unity ${bundle.unityVersion}` : "";
  els.unityBadge.hidden = !bundle.unityVersion;

  const linkable = /^https?:/i.test(state.src);
  els.bundleLink.hidden = !linkable;
  if (linkable) els.bundleLink.href = state.src;
}

function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function renderTypeFilter() {
  els.typeFilter.textContent = "";
  els.typeFilter.append(new Option(`Все типы (${state.assets.length})`, "all"));
  for (const item of state.types) {
    els.typeFilter.append(new Option(`${item.type} (${item.count})`, item.type));
  }
  els.typeFilter.value = state.type;
}

function renderTypeChips() {
  els.typeChips.textContent = "";
  if (!state.types.length) return;
  for (const item of state.types) {
    const chip = el("button", { className: "type-chip", type: "button" },
      item.type + " ",
      el("b", {}, String(item.count)));
    chip.classList.toggle("active", state.type === item.type);
    chip.addEventListener("click", () => setType(state.type === item.type ? "all" : item.type));
    els.typeChips.append(chip);
  }
}

function setType(type) {
  state.type = type;
  els.typeFilter.value = type;
  renderTypeChips();
  renderGrid();
}

/* ------------------------------------------------------------------ */
/* filters and grid                                                    */
/* ------------------------------------------------------------------ */

function applyFilters() {
  const query = state.query.trim().toLowerCase();
  let list = state.assets;
  if (state.type !== "all") list = list.filter((asset) => asset.type === state.type);
  if (query) {
    list = list.filter((asset) =>
      asset.name.toLowerCase().includes(query) ||
      (asset.path && asset.path.toLowerCase().includes(query)));
  }

  list = list.slice();
  if (state.sort === "size") {
    list.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  } else if (state.sort === "name-desc") {
    list.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  } else {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  state.view = list;
}

function thumbSize() {
  return Math.min(512, Math.max(160, Math.round(state.thumb * 1.5)));
}

function metaLine(asset) {
  if (asset.preview === "image") {
    const parts = [];
    if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
    if (asset.format) parts.push(asset.format);
    parts.push(formatBytes(asset.bytes));
    return parts.join(" · ");
  }
  if (asset.preview === "audio") {
    const parts = [formatDuration(asset.duration)];
    if (asset.channels === 1) parts.push("моно");
    else if (asset.channels === 2) parts.push("стерео");
    else if (asset.channels) parts.push(`${asset.channels} кан.`);
    if (asset.compressionFormat) parts.push(asset.compressionFormat);
    parts.push(formatBytes(asset.bytes));
    return parts.join(" · ");
  }
  if (asset.preview === "text") return `${formatBytes(asset.bytes)} · текст`;
  return `${asset.type} · ${formatBytes(asset.bytes)}`;
}

function renderGrid() {
  applyFilters();
  const list = state.view;

  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }

  els.grid.textContent = "";
  els.grid.style.setProperty("--card", `${state.thumb}px`);

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const data = state.cardMeta.get(entry.target);
      if (data) requestThumb(data);
    }
  }, { rootMargin: "350px 0px" });
  state.observer = observer;

  const max = thumbSize();
  const fragment = document.createDocumentFragment();

  for (const asset of list) {
    const card = el("button", { className: "card", type: "button", title: asset.name });
    card.dataset.pid = asset.pid;

    const thumb = el("div", { className: "thumb" });
    let img = null;

    if (asset.preview === "image" && !asset.error) {
      img = el("img", { alt: "", decoding: "async" });
      thumb.append(img);
      thumb.classList.add("pending");
    } else {
      const glyph = asset.error ? "⚠"
        : asset.preview === "audio" ? "♪"
          : asset.preview === "text" ? "T"
            : "•";
      thumb.append(el("span", { className: "glyph" }, glyph));
      if (asset.error) thumb.classList.add("broken");
      card.title = asset.error ? `${asset.name}\n${asset.error}` : asset.name;
    }

    const caption = el("div", { className: "cap" },
      el("span", { className: "nm" }, asset.name),
      el("span", { className: "mt" }, metaLine(asset)));

    card.append(thumb, caption);
    card.addEventListener("click", () => openModal(asset));
    fragment.append(card);

    if (img) {
      const key = `${asset.pid}|${max}`;
      const data = { asset, img, thumb, key, max, generation: state.generation };
      state.cardMeta.set(card, data);
      const cached = state.thumbUrls.get(key);
      if (cached) {
        setThumb(data, cached);
      } else {
        observer.observe(card);
      }
    }
  }

  els.grid.append(fragment);

  const total = state.assets.length;
  els.resultCount.textContent = list.length === total ? `${total}` : `${list.length} из ${total}`;

  if (!state.bundle) {
    showOnboarding();
  } else if (!total) {
    showNotice("В бандле нет объектов", "Попробуйте другой файл или другую папку.", false);
  } else if (!list.length) {
    showNotice("Ничего не найдено", "Измените запрос или сбросьте фильтр по типу.", false);
  } else {
    els.empty.hidden = true;
  }
}

function showOnboarding() {
  els.empty.hidden = false;
  els.emptyTitle.textContent = "Откройте Unity AssetBundle";
  els.emptyNote.textContent = "Пока в папке bundles/ ничего не найдено. " +
    "Положите туда *.webp / *.bundle или откройте файл вручную.";
  els.emptyActions.hidden = false;
}

function showNotice(title, note, actions) {
  els.empty.hidden = false;
  els.emptyTitle.textContent = title;
  els.emptyNote.textContent = note;
  els.emptyActions.hidden = !actions;
}

/* ------------------------------------------------------------------ */
/* thumbnails                                                          */
/* ------------------------------------------------------------------ */

const thumbQueue = [];
let thumbRunning = 0;

function requestThumb(data) {
  const cached = state.thumbUrls.get(data.key);
  if (cached) {
    setThumb(data, cached);
    return;
  }
  const waiters = state.thumbWaiters.get(data.key);
  if (waiters) {
    waiters.push(data);
    return;
  }
  state.thumbWaiters.set(data.key, [data]);
  thumbQueue.push({ key: data.key, pid: data.asset.pid, max: data.max, generation: data.generation });
  pumpThumbQueue();
}

function pumpThumbQueue() {
  while (thumbRunning < THUMB_CONCURRENCY && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbRunning += 1;
    call("image", { pid: job.pid, max: job.max })
      .then((message) => {
        if (job.generation !== state.generation) return;
        const url = URL.createObjectURL(message.blob);
        state.thumbUrls.set(job.key, url);
        const waiters = state.thumbWaiters.get(job.key) || [];
        state.thumbWaiters.delete(job.key);
        for (const waiter of waiters) setThumb(waiter, url);
      })
      .catch((error) => {
        if (job.generation !== state.generation) return;
        const waiters = state.thumbWaiters.get(job.key) || [];
        state.thumbWaiters.delete(job.key);
        for (const waiter of waiters) setBroken(waiter, error.message);
      })
      .finally(() => {
        thumbRunning -= 1;
        pumpThumbQueue();
      });
  }
}

function setThumb(data, url) {
  data.img.src = url;
  data.thumb.classList.remove("pending");
  data.thumb.classList.add("ready");
}

function setBroken(data, message) {
  data.img.remove();
  data.thumb.classList.remove("pending");
  data.thumb.classList.add("broken");
  data.thumb.append(el("span", { className: "glyph", title: message || "" }, "⚠"));
}

/* ------------------------------------------------------------------ */
/* modal                                                               */
/* ------------------------------------------------------------------ */

function openModal(asset) {
  state.current = asset;
  state.modalToken += 1;
  const token = state.modalToken;
  clearModalTemp();

  els.mTitle.textContent = asset.name;
  els.mSub.textContent = [
    asset.type,
    asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
    asset.format || null,
    asset.bytes ? formatBytes(asset.bytes) : null,
  ].filter(Boolean).join("  ·  ");

  els.mStage.textContent = "";
  els.mDownload.hidden = true;
  els.mDownload.removeAttribute("href");
  els.mDownload.removeAttribute("download");

  renderModalMeta(asset);

  if (asset.preview === "image") {
    loadFullImage(asset, token);
  } else if (asset.preview === "audio") {
    loadModalAudio(asset, token);
  } else if (asset.preview === "text") {
    loadModalText(asset, token);
  } else {
    els.mStage.append(el("div", { className: "note" },
      `Предпросмотр для типа ${asset.type} не поддерживается.`,
      el("br"),
      "Метаданные объекта доступны справа."));
  }

  updateNav();
  if (!els.modal.open) els.modal.showModal();
}

function spinner(text) {
  return el("div", { className: "stage-loading" },
    el("div", { className: "spinner" }),
    el("span", { className: "muted" }, text));
}

function stageError(error) {
  els.mStage.textContent = "";
  els.mStage.append(el("div", { className: "note" },
    el("strong", {}, "Не удалось декодировать"),
    el("br"),
    error.message || String(error),
    error.hint ? el("p", { className: "muted" }, error.hint) : null));
}

async function loadFullImage(asset, token) {
  const cached = state.fullCache.get(asset.pid);
  if (cached) {
    showImage(asset, cached);
    return;
  }

  els.mStage.append(spinner("Декодирую текстуру…"));
  try {
    const message = await call("image", { pid: asset.pid, max: 0 });
    if (token !== state.modalToken) return;
    const url = URL.createObjectURL(message.blob);
    state.fullCache.set(asset.pid, url);
    trimFullCache();
    showImage(asset, url);
  } catch (error) {
    if (token !== state.modalToken) return;
    stageError(error);
  }
}

function showImage(asset, url) {
  els.mStage.textContent = "";
  els.mStage.append(el("img", { alt: asset.name, src: url }));
  setDownload(url, `${safeFileBase(asset.name)}.png`, "Скачать PNG");
}

function trimFullCache() {
  while (state.fullCache.size > FULL_CACHE_LIMIT) {
    const oldest = state.fullCache.keys().next().value;
    const url = state.fullCache.get(oldest);
    state.fullCache.delete(oldest);
    URL.revokeObjectURL(url);
  }
}

async function loadModalAudio(asset, token) {
  els.mStage.append(spinner("Готовлю аудио…"));
  try {
    const message = await call("audio", { pid: asset.pid });
    if (token !== state.modalToken) return;
    const url = URL.createObjectURL(message.blob);
    state.modalUrls.push(url);

    els.mStage.textContent = "";
    els.mStage.append(el("audio", { controls: true, preload: "metadata", src: url }));
    if (!message.playable) {
      els.mStage.append(el("p", { className: "note" },
        `Формат .${message.ext} браузер проигрывать не умеет, но файл можно скачать.`));
    }
    setDownload(url, `${safeFileBase(asset.name)}.${message.ext}`, "Скачать аудио");
  } catch (error) {
    if (token !== state.modalToken) return;
    stageError(error);
  }
}

async function loadModalText(asset, token) {
  els.mStage.append(spinner("Читаю текст…"));
  try {
    const message = await call("text", { pid: asset.pid });
    if (token !== state.modalToken) return;

    els.mStage.textContent = "";
    const pre = el("pre", {}, message.text);
    if (message.truncated) pre.textContent += "\n\n… (показаны первые 2 млн символов)";
    els.mStage.append(pre);

    const blob = new Blob([message.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    state.modalUrls.push(url);
    setDownload(url, `${safeFileBase(asset.name)}.txt`, "Скачать текст");
  } catch (error) {
    if (token !== state.modalToken) return;
    stageError(error);
  }
}

function setDownload(url, filename, label) {
  els.mDownload.hidden = false;
  els.mDownload.href = url;
  els.mDownload.download = filename;
  els.mDownload.textContent = label;
}

function renderModalMeta(asset) {
  const rows = [
    ["Тип", asset.type],
    ["PID", asset.pid],
    ["Размер", formatBytes(asset.bytes)],
  ];

  if (asset.width && asset.height) rows.push(["Текстура", `${asset.width}×${asset.height}`]);
  if (asset.format) rows.push(["Формат", String(asset.format)]);
  if (asset.compression) rows.push(["Сжатие", String(asset.compression)]);
  if (asset.mipCount) rows.push(["Mip-уровни", String(asset.mipCount)]);
  if (asset.colorSpace) rows.push(["Цвет", String(asset.colorSpace)]);
  if (asset.duration) rows.push(["Длительность", formatDuration(asset.duration)]);
  if (asset.frequency) rows.push(["Частота", `${asset.frequency} Гц`]);
  if (asset.channels) rows.push(["Каналы", String(asset.channels)]);
  if (asset.compressionFormat) rows.push(["Кодек", String(asset.compressionFormat)]);
  if (asset.textLength) rows.push(["Символов", String(asset.textLength)]);
  if (asset.error) rows.push(["Ошибка", asset.error]);

  const dl = el("dl");
  for (const [term, value] of rows) {
    dl.append(el("dt", {}, term), el("dd", {}, value));
  }

  const sources = el("div", { className: "src" });
  if (asset.path) sources.append(el("div", {}, asset.path));
  if (state.src) sources.append(el("div", {}, state.src));
  else if (state.bundle) sources.append(el("div", {}, `локальный файл · ${state.bundle.label}`));

  els.mMeta.textContent = "";
  els.mMeta.append(dl, sources);
}

function updateNav() {
  const index = state.current ? state.view.indexOf(state.current) : -1;
  els.mPos.textContent = index >= 0 ? `${index + 1} / ${state.view.length}` : "";
  els.mPrev.disabled = index <= 0;
  els.mNext.disabled = index < 0 || index >= state.view.length - 1;
}

function stepModal(delta) {
  if (!state.current) return;
  const index = state.view.indexOf(state.current);
  const next = state.view[index + delta];
  if (next) openModal(next);
}

/* ------------------------------------------------------------------ */
/* opening sources                                                     */
/* ------------------------------------------------------------------ */

function setUrlParam(value) {
  const url = new URL(location.href);
  if (value) url.searchParams.set("src", value);
  else url.searchParams.delete("src");
  history.replaceState(null, "", url);
}

async function openUrl(input, options = {}) {
  const raw = String(input || "").trim();
  if (!raw) return;

  let url;
  try {
    url = new URL(raw, document.baseURI);
  } catch {
    toast("Некорректная ссылка");
    return;
  }
  if (!/^https?:/i.test(url.protocol)) {
    toast("Поддерживаются только http(s)-ссылки. Локальный файл откройте кнопкой «Файл…».");
    return;
  }

  const token = (state.loadToken += 1);
  beginWork("Скачиваю бандл…");
  hideError();

  try {
    const message = await call("load", { url: url.href, wasmPath: WASM_PATH }, {
      onProgress: updateProgress,
    });
    if (token !== state.loadToken) return;

    applyLoaded(message, url.href);
    setUrlParam(url.href);
    els.src.value = url.href;
    markActiveChip();

    if (!options.silent) {
      toast(`${message.bundle.bundle}: ${message.bundle.total} ассетов`, true);
    }
  } catch (error) {
    if (token !== state.loadToken) return;
    if (error.name === "AbortError") return;
    showError("Не удалось открыть бандл", error.message, error.hint || defaultHint(error));
    toast(error.message);
    if (!state.bundle) showOnboarding();
  } finally {
    endWork();
  }
}

function defaultHint(error) {
  if (error && error.name === "NetworkError") {
    return "Сторонний сервер не разрешает чтение из браузера (CORS). Скачайте файл и откройте его кнопкой «Файл…».";
  }
  if (error && error.name === "HttpError") {
    return "Проверьте ссылку: файл должен существовать и быть доступным без авторизации.";
  }
  return "";
}

async function openFiles(fileList) {
  const files = [...fileList].filter(Boolean);
  if (!files.length) return;

  const token = (state.loadToken += 1);
  beginWork("Читаю локальный файл…");
  hideError();

  try {
    const payload = [];
    for (const file of files) {
      payload.push({ name: file.name, data: await file.arrayBuffer() });
    }

    const message = await call("load", { files: payload, wasmPath: WASM_PATH }, {
      transfer: payload.map((item) => item.data),
      onProgress: updateProgress,
    });
    if (token !== state.loadToken) return;

    const label = files.length === 1 ? files[0].name : `${files.length} файла`;
    applyLoaded(message, "", label);
    setUrlParam(null);
    toast(`Открыт ${label}: ${message.bundle.total} ассетов`, true);
  } catch (error) {
    if (token !== state.loadToken) return;
    showError("Не удалось разобрать файл", error.message, error.hint || defaultHint(error));
    toast(error.message);
    if (!state.bundle) showOnboarding();
  } finally {
    endWork();
  }
}

/* ------------------------------------------------------------------ */
/* bundle folder scan                                                  */
/* ------------------------------------------------------------------ */

function looksLikeBundle(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(8, bytes.length)));
  if (head.startsWith("UnityFS") || head.startsWith("UnityWeb") || head.startsWith("UnityRaw")) return true;
  return bytes[0] === 0x1f && bytes[1] === 0x8b; // gzip wrapper
}

async function readFirstChunk(response) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.subarray(0, 8);
  }
  const reader = response.body.getReader();
  try {
    const { value } = await reader.read();
    return value ? value.subarray(0, 8) : new Uint8Array(0);
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function probeBundle(url) {
  let head;
  try {
    head = await fetch(url, { method: "HEAD", cache: "no-store" });
  } catch {
    return { networkError: true };
  }
  if (!head.ok) return null;

  const bytes = Number(head.headers.get("content-length")) || 0;
  try {
    const range = await fetch(url, { headers: { Range: "bytes=0-7" }, cache: "no-store" });
    if (!range.ok && range.status !== 206) return null;

    // A server that ignores Range still lets us read and cancel the first chunk.
    // This rejects SPA/404 fallbacks that answer 200 with an HTML page.
    const magic = await readFirstChunk(range);
    if (!looksLikeBundle(magic)) return null;
  } catch {
    // Range/CORS not available — trust the HEAD response.
  }
  return { bytes };
}

function candidateNames(name) {
  return /\.(webp|bundle|unity3d|assets|dat|bin)$/i.test(name) ? [name] : [`${name}.webp`, `${name}.bundle`];
}

function displayLabel(name) {
  return String(name).replace(/\.(webp|bundle|unity3d|assets|dat|bin)$/i, "");
}

async function mapLimit(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await worker(items[current]);
    }
  });
  await Promise.all(runners);
}

async function scanBase(input, options = {}) {
  const raw = String(input || "").trim() || "bundles/";
  let base;
  try {
    base = new URL(raw, document.baseURI);
  } catch {
    toast("Некорректный адрес папки");
    return;
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";

  const token = (state.scanToken += 1);
  els.chips.textContent = "";
  els.chips.append(el("span", { className: "chip static" }, "Проверяю папку…"));

  let candidates = null;
  let manifestUsed = false;
  try {
    const response = await fetch(new URL("bundles.json", base), { cache: "no-store" });
    if (response.ok && /json/i.test(response.headers.get("content-type") || "")) {
      const data = await response.json();
      const list = Array.isArray(data) ? data : data.bundles || data.files || [];
      const parsed = list
        .map((item) => (typeof item === "string" ? { name: item } : item))
        .filter((item) => item && item.name);
      if (parsed.length) {
        candidates = parsed;
        manifestUsed = true;
      }
    }
  } catch {
    // no manifest: fall back to known names
  }
  if (!candidates) candidates = KNOWN_BUNDLES.map((name) => ({ name }));

  const found = [];
  let networkErrors = 0;

  await mapLimit(candidates, 6, async (candidate) => {
    for (const name of candidateNames(candidate.name)) {
      let url;
      try {
        url = new URL(name, base);
      } catch {
        continue;
      }
      const probe = await probeBundle(url.href);
      if (probe && probe.networkError) {
        networkErrors += 1;
        return;
      }
      if (probe) {
        const declared = Number(candidate.bytes) || 0;
        found.push({
          label: displayLabel(name),
          url: url.href,
          bytes: declared || probe.bytes || 0,
          order: KNOWN_BUNDLES.indexOf(displayLabel(candidate.name)),
        });
        return;
      }
    }
  });

  if (token !== state.scanToken) return;

  found.sort((a, b) => (a.order < 0 ? 999 : a.order) - (b.order < 0 ? 999 : b.order)
    || a.label.localeCompare(b.label));

  els.chips.textContent = "";
  if (!found.length) {
    els.chips.append(el("span", { className: "chip static" }, "Бандлы не найдены"));
    if (!options.auto) {
      if (networkErrors) {
        toast("Не удалось проверить папку: сервер не отдаёт CORS или папка недоступна");
      } else {
        toast("В этой папке нет известных бандлов");
      }
    }
    if (!state.bundle) {
      els.emptyNote.textContent = networkErrors
        ? "Папку не удалось проверить: сервер не отдаёт CORS. Скачайте бандл и перетащите его в окно."
        : "Пока в папке bundles/ ничего не найдено. Положите туда *.webp / *.bundle или откройте файл вручную.";
    }
    return;
  }

  for (const item of found) {
    const chip = el("button", { className: "chip", type: "button", title: item.url },
      item.label,
      item.bytes ? el("span", { className: "sz" }, formatBytes(item.bytes)) : null);
    chip.dataset.url = item.url;
    chip.addEventListener("click", () => openUrl(item.url));
    els.chips.append(chip);
  }

  if (!manifestUsed) {
    const missing = KNOWN_BUNDLES.length - found.length;
    if (missing > 0) {
      els.chips.append(el("span", { className: "chip static" }, `+${missing} нет`));
    }
  }

  markActiveChip();

  if (options.autoOpen && !state.assets.length) {
    const preferred = found.find((item) => /(^|\/)itemicons$/i.test(item.label)) || found[0];
    if (preferred) openUrl(preferred.url, { silent: false });
  }
}

function markActiveChip() {
  for (const chip of els.chips.querySelectorAll(".chip[data-url]")) {
    chip.classList.toggle("active", chip.dataset.url === state.src);
  }
}

/* ------------------------------------------------------------------ */
/* zip export                                                          */
/* ------------------------------------------------------------------ */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function hideZipBar() {
  state.pendingZip = null;
  els.zipbar.hidden = true;
  els.zipSave.hidden = true;
  els.zipClose.hidden = true;
  els.zipCancel.hidden = false;
}

async function exportZip() {
  if (!state.assets.length || state.zipId) return;

  state.pendingZip = null;
  els.zipbar.hidden = false;
  els.zipTitle.textContent = "Собираю ZIP";
  els.zipFill.style.width = "0%";
  els.zipStatus.textContent = "Подготовка…";
  els.zipCancel.hidden = false;
  els.zipCancel.disabled = false;
  els.zipSave.hidden = true;
  els.zipClose.hidden = true;
  beginWork("Собираю ZIP…");

  try {
    const message = await call("zip", {}, {
      onStart: (id) => {
        state.zipId = id;
      },
      onProgress: (event) => {
        if (event.phase === "zip") {
          const percent = event.total ? (event.done / event.total) * 100 : 0;
          els.zipFill.style.width = `${percent}%`;
          els.zipStatus.textContent = `${event.done} / ${event.total}`;
        } else if (event.phase === "zip-pack") {
          els.zipFill.style.width = "100%";
          els.zipStatus.textContent = "Упаковываю архив…";
        }
      },
    });

    const name = safeFileBase(state.bundle ? state.bundle.bundle : "bundle");
    const failed = message.errors && message.errors.length
      ? `, ошибок: ${message.errors.length}`
      : "";

    // A download started after an await is not tied to a user gesture, and
    // Chromium blocks it. Keep the archive in memory and let the user click Save.
    state.pendingZip = { blob: message.blob, name: `${name}.zip` };
    els.zipTitle.textContent = "ZIP готов";
    els.zipFill.style.width = "100%";
    els.zipStatus.textContent = `${message.files} файлов · ${formatBytes(message.size)}${failed}`;
    els.zipCancel.hidden = true;
    els.zipSave.hidden = false;
    els.zipClose.hidden = false;
    toast("ZIP готов — нажмите «Скачать ZIP»", true);
  } catch (error) {
    if (error.name === "AbortError" || /отмен/i.test(error.message)) {
      toast("Экспорт отменён");
      hideZipBar();
    } else {
      toast("Не удалось собрать ZIP: " + error.message);
      hideZipBar();
    }
  } finally {
    state.zipId = null;
    endWork();
  }
}

function saveZip() {
  if (!state.pendingZip) return;
  downloadBlob(state.pendingZip.blob, state.pendingZip.name);
  toast("Архив сохраняется…", true);
  hideZipBar();
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  els.open.addEventListener("click", () => openUrl(els.src.value));
  els.src.addEventListener("keydown", (event) => {
    if (event.key === "Enter") openUrl(els.src.value);
  });

  els.scan.addEventListener("click", () => scanBase(els.base.value));
  els.base.addEventListener("keydown", (event) => {
    if (event.key === "Enter") scanBase(els.base.value);
  });

  els.pickFile.addEventListener("click", () => els.file.click());
  els.emptyPick.addEventListener("click", () => els.file.click());
  els.emptyScan.addEventListener("click", () => scanBase(els.base.value));

  els.file.addEventListener("change", () => {
    openFiles(els.file.files || []);
    els.file.value = "";
  });

  els.errorClose.addEventListener("click", hideError);

  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    clearTimeout(bindEvents.searchTimer);
    bindEvents.searchTimer = setTimeout(renderGrid, 120);
  });

  els.typeFilter.addEventListener("change", () => setType(els.typeFilter.value));

  els.sort.addEventListener("change", () => {
    state.sort = els.sort.value;
    renderGrid();
  });

  els.thumbSize.addEventListener("input", () => {
    state.thumb = Number(els.thumbSize.value);
    clearTimeout(bindEvents.thumbTimer);
    bindEvents.thumbTimer = setTimeout(() => {
      // Thumbnail keys embed the decode size, so old object URLs are dead weight.
      for (const url of state.thumbUrls.values()) URL.revokeObjectURL(url);
      state.thumbUrls.clear();
      state.thumbWaiters.clear();
      thumbQueue.length = 0;
      renderGrid();
    }, 90);
  });

  els.export.addEventListener("click", exportZip);
  els.zipSave.addEventListener("click", saveZip);
  els.zipClose.addEventListener("click", hideZipBar);
  els.zipCancel.addEventListener("click", () => {
    if (!state.zipId) return;
    worker.postMessage({ type: "cancel", id: state.zipId });
    els.zipCancel.disabled = true;
    els.zipStatus.textContent = "Отмена…";
  });

  els.mClose.addEventListener("click", () => els.modal.close());
  els.mPrev.addEventListener("click", () => stepModal(-1));
  els.mNext.addEventListener("click", () => stepModal(1));
  els.modal.addEventListener("close", () => {
    state.current = null;
    clearModalTemp();
  });
  els.modal.addEventListener("click", (event) => {
    if (event.target === els.modal) els.modal.close();
  });

  els.mCopy.addEventListener("click", async () => {
    if (!state.current) return;
    try {
      await navigator.clipboard.writeText(state.current.name);
      toast("Имя скопировано", true);
    } catch {
      toast("Не удалось скопировать имя");
    }
  });

  document.addEventListener("keydown", (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (event.key === "/" && !typing && !els.modal.open) {
      event.preventDefault();
      els.search.focus();
      return;
    }
    if (els.modal.open) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepModal(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepModal(1);
      }
    }
  });

  let dragDepth = 0;
  window.addEventListener("dragenter", (event) => {
    if (event.dataTransfer && [...event.dataTransfer.types].includes("Files")) {
      dragDepth += 1;
      els.drop.hidden = false;
      event.preventDefault();
    }
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.drop.hidden = true;
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.drop.hidden = true;
    if (event.dataTransfer && event.dataTransfer.files.length) {
      openFiles(event.dataTransfer.files);
    }
  });
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  bindEvents();
  els.base.value = "bundles/";
  els.thumbSize.value = String(state.thumb);
  els.grid.style.setProperty("--card", `${state.thumb}px`);

  if (location.protocol === "file:") {
    showError(
      "Страница открыта как локальный файл",
      "Браузер блокирует ES-модули и fetch по протоколу file://.",
      "Запустите `npm run dev` или опубликуйте сайт на GitHub Pages — тогда всё заработает."
    );
    showOnboarding();
    return;
  }

  const params = new URLSearchParams(location.search);
  const src = params.get("src");
  if (src) {
    els.src.value = src;
    openUrl(src);
    scanBase(els.base.value, { auto: true });
    return;
  }

  scanBase(els.base.value, { auto: true, autoOpen: true });
}

boot();
