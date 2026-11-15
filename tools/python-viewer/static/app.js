"use strict";

const $ = (selector) => document.querySelector(selector);

const els = {
  progress: $("#progress"),
  status: $("#statusText"),
  src: $("#src"),
  base: $("#base"),
  open: $("#open"),
  scan: $("#scan"),
  pickFile: $("#pickFile"),
  file: $("#file"),
  chips: $("#chips"),
  info: $("#bundleInfo"),
  bundleName: $("#bundleName"),
  bundleMeta: $("#bundleMeta"),
  bundleLink: $("#bundleLink"),
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
  emptyText: $("#emptyText"),
  drop: $("#drop"),
  toast: $("#toast"),
  modal: $("#modal"),
  mTitle: $("#mTitle"),
  mSub: $("#mSub"),
  mStage: $("#mStage"),
  mMeta: $("#mMeta"),
  mPrev: $("#mPrev"),
  mNext: $("#mNext"),
  mClose: $("#mClose"),
  mDownload: $("#mDownload"),
  mRaw: $("#mRaw"),
  mCopy: $("#mCopy"),
  mPos: $("#mPos"),
};

const state = {
  config: { default_src: "", default_base: "", bundles: [] },
  src: null,
  data: null,
  view: [],
  query: "",
  type: "all",
  sort: "name",
  thumb: 160,
  current: null,
  busy: 0,
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "—";
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function assetUrl(asset, mode, extra) {
  const params = new URLSearchParams({
    src: state.src,
    pid: String(asset.pid),
    mode,
  });
  for (const [key, value] of Object.entries(extra || {})) params.set(key, value);
  return `/api/asset?${params}`;
}

async function apiJson(path, params) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url);
  const type = response.headers.get("content-type") || "";
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    if (type.includes("json")) {
      const body = await response.json().catch(() => null);
      if (body && body.error) message = body.error;
    }
    throw new Error(message);
  }
  return type.includes("json") ? response.json() : response.text();
}

let toastTimer = null;
function toast(message, ok = false) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle("ok", ok);
  els.toast.hidden = !message;
  if (message) toastTimer = setTimeout(() => { els.toast.hidden = true; }, 6000);
}

function setBusy(on, text) {
  state.busy = Math.max(0, state.busy + (on ? 1 : -1));
  if (on && text) els.status.textContent = text;
  const busy = state.busy > 0;
  els.progress.hidden = !busy;
  els.status.hidden = !busy;
  document.body.style.cursor = busy ? "progress" : "";
}

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props || {});
  for (const child of children) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function metaLine(asset) {
  const parts = [];
  if (asset.w && asset.h) parts.push(`${asset.w}×${asset.h}`);
  if (asset.format) parts.push(String(asset.format));
  if (asset.bytes) parts.push(formatBytes(asset.bytes));
  if (!parts.length) parts.push(asset.type);
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

async function openSource(src, options) {
  const opts = options || {};
  src = (src || "").trim();
  if (!src) return;
  const token = (state.loadToken = (state.loadToken || 0) + 1);
  setBusy(true, "Скачиваю и парсю бандл…");
  try {
    const data = await apiJson("/api/list", {
      src,
      refresh: opts.refresh ? 1 : null,
    });
    if (token !== state.loadToken) return; // a newer load has started
    state.src = data.src;
    state.data = data;
    state.type = "all";
    state.query = "";
    state.sort = "name";
    els.src.value = data.src;
    els.search.value = "";
    els.sort.value = "name";
    renderInfo();
    renderTypeFilter();
    els.toolbar.hidden = false;
    renderGrid();
    markActiveChip();

    if (data.total === 0) showEmpty("В бандле нет объектов.");
    else els.empty.hidden = true;

    document.title = `${data.bundle || data.label} — Bundle Viewer`;
    if (/^https?:/i.test(data.src)) {
      history.replaceState(null, "", "?src=" + encodeURIComponent(data.src));
    }
  } catch (error) {
    toast("Не удалось открыть бандл: " + error.message);
    if (!state.data) showEmpty("Вставьте ссылку на бандл и нажмите «Открыть».");
  } finally {
    setBusy(false);
  }
}

function showEmpty(text) {
  els.empty.hidden = false;
  els.emptyText.textContent = text;
}

function renderInfo() {
  const data = state.data;
  els.info.hidden = false;
  els.bundleName.textContent = data.bundle || data.label;

  const meta = [];
  if (data.unity_version && data.unity_version !== "?") meta.push(`Unity ${data.unity_version}`);
  meta.push(`${data.total} ассетов`);
  meta.push(formatBytes(data.bytes));
  meta.push(`парсинг ${data.parse_seconds.toFixed(1)} с`);
  els.bundleMeta.textContent = meta.join("  ·  ");

  const linkable = /^https?:/i.test(data.src);
  els.bundleLink.hidden = !linkable;
  if (linkable) els.bundleLink.href = data.src;

  els.typeChips.textContent = "";
  for (const item of data.types) {
    const chip = el("button", { className: "type-chip", type: "button" },
      item.type + " ",
      el("b", {}, String(item.count))
    );
    chip.addEventListener("click", () => {
      state.type = item.type;
      els.typeFilter.value = item.type;
      renderGrid();
    });
    els.typeChips.append(chip);
  }
}

function renderTypeFilter() {
  const data = state.data;
  els.typeFilter.textContent = "";
  els.typeFilter.append(new Option(`Все типы (${data.total})`, "all"));
  for (const item of data.types) {
    els.typeFilter.append(new Option(`${item.type} (${item.count})`, item.type));
  }
  els.typeFilter.value = "all";
}

/* ------------------------------------------------------------------ */
/* version scan                                                        */
/* ------------------------------------------------------------------ */

async function scanBase(options) {
  const opts = options || {};
  const base = els.base.value.trim();
  if (!base) return;
  els.chips.textContent = "";
  els.chips.append(el("span", { className: "chip static" }, "Проверяю бандлы…"));
  try {
    const data = await apiJson("/api/probe", { base });
    const found = data.bundles.filter((item) => item.ok);
    const order = new Map(state.config.bundles.map((name, index) => [name, index]));
    found.sort((a, b) =>
      (order.has(a.name) ? order.get(a.name) : 999) -
      (order.has(b.name) ? order.get(b.name) : 999));

    els.chips.textContent = "";
    if (!found.length) {
      els.chips.append(el("span", { className: "chip static" },
        "По этому адресу бандлы не найдены"));
      if (!opts.silent) toast("В этой папке ничего не нашлось");
      return;
    }
    for (const item of found) {
      const chip = el("button", { className: "chip", type: "button", title: item.url },
        item.name,
        el("span", { className: "sz" }, formatBytes(item.bytes)));
      chip.dataset.url = item.url;
      chip.addEventListener("click", () => openSource(item.url));
      els.chips.append(chip);
    }
    const missing = data.bundles.length - found.length;
    if (missing > 0) {
      els.chips.append(el("span", { className: "chip static" },
        `+${missing} нет в этой версии`));
    }
    markActiveChip();
  } catch (error) {
    els.chips.textContent = "";
    els.chips.append(el("span", { className: "chip static" }, "Ошибка проверки"));
    toast("Не удалось проверить папку: " + error.message);
  }
}

function markActiveChip() {
  for (const chip of els.chips.querySelectorAll(".chip[data-url]")) {
    chip.classList.toggle("active", chip.dataset.url === state.src);
  }
}

/* ------------------------------------------------------------------ */
/* grid                                                                */
/* ------------------------------------------------------------------ */

function applyFilters() {
  const data = state.data;
  if (!data) { state.view = []; return; }
  const query = state.query.trim().toLowerCase();
  let list = data.assets;
  if (state.type !== "all") list = list.filter((asset) => asset.type === state.type);
  if (query) list = list.filter((asset) => asset.name.toLowerCase().includes(query));

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

function renderGrid() {
  applyFilters();
  const list = state.view;
  els.grid.textContent = "";
  els.grid.style.setProperty("--card", `${state.thumb}px`);

  const thumbWidth = Math.min(512, Math.round(state.thumb * 1.6));
  const fragment = document.createDocumentFragment();

  for (const asset of list) {
    const card = el("button", { className: "card", type: "button", title: asset.name });
    card.dataset.pid = String(asset.pid);

    const thumb = el("div", { className: "thumb" });
    if (asset.preview === "image") {
      const img = el("img", {
        loading: "lazy",
        decoding: "async",
        alt: asset.name,
        src: assetUrl(asset, "thumb", { w: thumbWidth }),
      });
      img.addEventListener("error", () => {
        card.classList.add("broken");
        img.replaceWith(el("span", { className: "glyph" }, "⚠"));
      });
      thumb.append(img);
    } else {
      const glyph = asset.preview === "audio" ? "♪" : asset.preview === "text" ? "T" : "•";
      thumb.append(el("span", { className: "glyph" }, glyph));
    }

    const caption = el("div", { className: "cap" },
      el("span", { className: "nm" }, asset.name),
      el("span", { className: "mt" }, metaLine(asset)));

    card.append(thumb, caption);
    card.addEventListener("click", () => openModal(asset));
    fragment.append(card);
  }

  els.grid.append(fragment);

  if (!list.length) {
    showEmpty(state.data && state.data.total
      ? "Ничего не найдено — измените запрос или фильтр."
      : "В бандле нет объектов.");
  } else {
    els.empty.hidden = true;
  }

  const total = state.data ? state.data.total : 0;
  els.resultCount.textContent = list.length === total
    ? `${total}`
    : `${list.length} из ${total}`;
}

/* ------------------------------------------------------------------ */
/* modal                                                               */
/* ------------------------------------------------------------------ */

function openModal(asset) {
  state.current = asset;
  els.mTitle.textContent = asset.name;
  els.mSub.textContent = [
    asset.type,
    asset.w && asset.h ? `${asset.w}×${asset.h}` : null,
    asset.format ? String(asset.format) : null,
    asset.bytes ? formatBytes(asset.bytes) : null,
  ].filter(Boolean).join("  ·  ");

  els.mStage.textContent = "";
  els.mDownload.hidden = false;
  els.mDownload.removeAttribute("download");
  els.mRaw.href = assetUrl(asset, "raw", { dl: 1 });

  if (asset.preview === "image") {
    const img = el("img", { alt: asset.name, src: assetUrl(asset, "full") });
    els.mStage.append(img);
    els.mDownload.href = assetUrl(asset, "full", { dl: 1 });
    els.mDownload.textContent = "Скачать PNG";
    els.mDownload.setAttribute("download", asset.name + ".png");
  } else if (asset.preview === "audio") {
    els.mStage.append(el("audio", {
      controls: true,
      preload: "metadata",
      src: assetUrl(asset, "full"),
    }));
    els.mDownload.href = assetUrl(asset, "full", { dl: 1 });
    els.mDownload.textContent = "Скачать аудио";
  } else if (asset.preview === "text") {
    const pre = el("pre", {}, "Загрузка…");
    els.mStage.append(pre);
    fetch(assetUrl(asset, "full"))
      .then((response) => response.text())
      .then((text) => {
        pre.textContent = text.length > 400000
          ? text.slice(0, 400000) + "\n\n… (обрезано)"
          : text;
      })
      .catch((error) => { pre.textContent = "Не удалось прочитать: " + error.message; });
    els.mDownload.href = assetUrl(asset, "full", { dl: 1 });
    els.mDownload.textContent = "Скачать текст";
  } else {
    els.mStage.append(el("div", { className: "note" },
      `Предпросмотр для типа ${asset.type} не поддерживается. `,
      "Можно скачать сырые сериализованные байты."));
    els.mDownload.hidden = true;
  }

  const rows = [
    ["Тип", asset.type],
    ["PID", String(asset.pid)],
    ["Размер", asset.bytes ? formatBytes(asset.bytes) : "—"],
  ];
  if (asset.w && asset.h) rows.push(["Текстура", `${asset.w}×${asset.h}`]);
  if (asset.format) rows.push(["Формат", String(asset.format)]);
  if (asset.error) rows.push(["Ошибка", asset.error]);

  const dl = el("dl");
  for (const [term, value] of rows) {
    dl.append(el("dt", {}, term), el("dd", {}, value));
  }
  els.mMeta.textContent = "";
  els.mMeta.append(dl, el("div", { className: "src" }, state.src));

  updateNav();
  if (!els.modal.open) els.modal.showModal();
}

function updateNav() {
  const index = state.view.indexOf(state.current);
  els.mPos.textContent = index >= 0 ? `${index + 1} / ${state.view.length}` : "";
  els.mPrev.disabled = index <= 0;
  els.mNext.disabled = index < 0 || index >= state.view.length - 1;
}

function stepModal(delta) {
  const index = state.view.indexOf(state.current);
  const next = state.view[index + delta];
  if (next) openModal(next);
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

async function uploadFile(file) {
  if (!file) return;
  setBusy(true, `Загружаю ${file.name}…`);
  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { "X-Filename": encodeURIComponent(file.name) },
      body: file,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || response.statusText);
    toast(`Загружено: ${body.label} (${formatBytes(body.bytes)})`, true);
    await openSource(body.src);
  } catch (error) {
    toast("Не удалось загрузить файл: " + error.message);
  } finally {
    setBusy(false);
  }
}

async function exportZip() {
  if (!state.src) return;
  setBusy(true, "Собираю ZIP (это может занять время)…");
  try {
    const response = await fetch(`/api/export?src=${encodeURIComponent(state.src)}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || response.statusText);
    }
    const blob = await response.blob();
    const name = (state.data.bundle || "bundle").replace(/[^\w.-]+/g, "_");
    const url = URL.createObjectURL(blob);
    const link = el("a", { href: url, download: name + ".zip" });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`ZIP готов: ${formatBytes(blob.size)}`, true);
  } catch (error) {
    toast("Экспорт не удался: " + error.message);
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  els.open.addEventListener("click", () => openSource(els.src.value));
  els.src.addEventListener("keydown", (event) => {
    if (event.key === "Enter") openSource(els.src.value);
  });

  els.scan.addEventListener("click", () => scanBase());
  els.base.addEventListener("keydown", (event) => {
    if (event.key === "Enter") scanBase();
  });

  els.pickFile.addEventListener("click", () => els.file.click());
  els.file.addEventListener("change", () => {
    uploadFile(els.file.files && els.file.files[0]);
    els.file.value = "";
  });

  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    clearTimeout(bindEvents.searchTimer);
    bindEvents.searchTimer = setTimeout(renderGrid, 120);
  });

  els.typeFilter.addEventListener("change", () => {
    state.type = els.typeFilter.value;
    renderGrid();
  });

  els.sort.addEventListener("change", () => {
    state.sort = els.sort.value;
    renderGrid();
  });

  els.thumbSize.addEventListener("input", () => {
    state.thumb = Number(els.thumbSize.value);
    clearTimeout(bindEvents.thumbTimer);
    bindEvents.thumbTimer = setTimeout(renderGrid, 80);
  });

  els.export.addEventListener("click", exportZip);

  els.mClose.addEventListener("click", () => els.modal.close());
  els.mPrev.addEventListener("click", () => stepModal(-1));
  els.mNext.addEventListener("click", () => stepModal(1));
  els.mCopy.addEventListener("click", async () => {
    if (!state.current) return;
    try {
      await navigator.clipboard.writeText(state.current.name);
      toast("Имя скопировано", true);
    } catch {
      toast("Не удалось скопировать");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== els.search
        && !els.modal.open) {
      event.preventDefault();
      els.search.focus();
      return;
    }
    if (els.modal.open) {
      if (event.key === "ArrowLeft") { event.preventDefault(); stepModal(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); stepModal(1); }
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
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) uploadFile(file);
  });
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

(async function init() {
  bindEvents();
  try {
    state.config = await apiJson("/api/config");
  } catch (error) {
    toast("Сервер не отвечает: " + error.message);
    return;
  }

  els.base.value = state.config.default_base;
  els.thumbSize.value = String(state.thumb);
  els.grid.style.setProperty("--card", `${state.thumb}px`);

  const params = new URLSearchParams(location.search);
  const src = params.get("src") || state.config.default_src;
  if (src) {
    els.src.value = src;
    openSource(src);
  }

  if (state.config.default_base) scanBase({ silent: true });
})();
