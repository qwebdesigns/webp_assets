(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var API = params.get('api') || window.API_URL || '';

  // Имена бандлов — как в BLOCKADE/AssetBundles (без Windows, его нет на сервере).
  var BUNDLES = [
    'itemicons', 'ui', 'hud', 'atlases', 'zoomtextures', 'player_skins',
    'actions', 'flags', 'quest', 'sounds', 'generic_sounds', 'soundtrack',
    'maintheme', 'season1', 'season2', 'season3', 'season4', 'unifiedraytracing',
    'heavy_tank_data', 'helicopter_data', 'jeep_data', 'light_tank_data',
    'medium_tank_data'
  ];

  var THUMB = 176;
  var CONCURRENCY = 4;

  var els = {
    bundles: document.getElementById('bundles'),
    search: document.getElementById('search'),
    type: document.getElementById('type'),
    status: document.getElementById('status'),
    pixelated: document.getElementById('pixelated'),
    progress: document.getElementById('progress'),
    bar: document.getElementById('progress-bar'),
    grid: document.getElementById('grid'),
    overlay: document.getElementById('overlay'),
    preview: document.getElementById('preview'),
    name: document.getElementById('asset-name'),
    meta: document.getElementById('asset-meta'),
    download: document.getElementById('download'),
    zoom: document.getElementById('zoom'),
    close: document.getElementById('close')
  };

  var worker = new Worker('viewer-worker.js', { type: 'module' });
  var seq = 0;
  var pending = new Map();

  var generation = 0;
  var assets = [];
  var thumbUrls = new Map();
  var thumbQueue = [];
  var thumbRunning = 0;
  var observer = null;
  var overlayUrl = null;

  function applyPixelated() {
    document.body.classList.toggle('pixelated', els.pixelated.checked);
  }

  applyPixelated();

  worker.onmessage = function (event) {
    var message = event.data;
    var job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    if (message.type === 'error') {
      job.reject(new Error(message.message || 'Ошибка воркера'));
    } else {
      job.resolve(message);
    }
  };

  function call(type, payload, transfer) {
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      worker.postMessage(Object.assign({ id: id, type: type }, payload), transfer || []);
    });
  }

  /* ---------------------------------------------------------------- */
  /* список бандлов                                                    */
  /* ---------------------------------------------------------------- */

  BUNDLES.forEach(function (name) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'bundle';
    button.textContent = name;
    button.addEventListener('click', function () { openBundle(name, button); });
    els.bundles.appendChild(button);
  });

  /* ---------------------------------------------------------------- */
  /* загрузка бандла                                                   */
  /* ---------------------------------------------------------------- */

  async function openBundle(name, button) {
    if (!API) {
      setStatus('Не задан адрес API в config.js', 'error');
      return;
    }

    generation += 1;
    var gen = generation;
    Array.prototype.forEach.call(els.bundles.children, function (b) {
      b.classList.toggle('active', b === button);
    });

    clearThumbs();
    assets = [];
    els.grid.textContent = '';
    els.type.length = 1;
    els.search.value = '';
    showProgress(0);
    setStatus('Скачиваю ' + name + '…');

    try {
      var response = await fetch(API + '?bundle=' + encodeURIComponent(name));
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + (await response.text()).slice(0, 200));
      }

      var total = Number(response.headers.get('content-length')) || 0;
      var buffer = await readWithProgress(response, total);
      if (gen !== generation) return;

      showProgress(100);
      setStatus('Разбираю ' + name + '…');

      var loaded = await call('load', { name: name + '.webp', data: buffer }, [buffer]);
      if (gen !== generation) return;

      assets = loaded.assets;
      render(loaded.info);
      hideProgress();
    } catch (error) {
      hideProgress();
      setStatus('Ошибка: ' + error.message, 'error');
    }
  }

  async function readWithProgress(response, total) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      return await response.arrayBuffer();
    }

    var reader = response.body.getReader();
    var chunks = [];
    var received = 0;

    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      received += step.value.length;
      if (total) {
        showProgress(Math.round((received / total) * 100), formatBytes(received) + ' из ' + formatBytes(total));
      } else {
        showProgress(-1, formatBytes(received));
      }
    }

    var bytes = new Uint8Array(received);
    var offset = 0;
    chunks.forEach(function (chunk) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    });
    return bytes.buffer;
  }

  /* ---------------------------------------------------------------- */
  /* отрисовка                                                         */
  /* ---------------------------------------------------------------- */

  function render(info) {
    var counts = {};
    assets.forEach(function (asset) {
      counts[asset.type] = (counts[asset.type] || 0) + 1;
    });

    Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).forEach(function (type) {
      var option = document.createElement('option');
      option.value = type;
      option.textContent = type + ' (' + counts[type] + ')';
      els.type.appendChild(option);
    });

    setStatus(
      info.name + ': ' + info.total + ' объектов · ' + formatBytes(info.bytes) +
      ' · разбор ' + info.parseMs + ' мс'
    );

    drawGrid();
  }

  function drawGrid() {
    if (observer) observer.disconnect();
    els.grid.textContent = '';

    var query = els.search.value.trim().toLowerCase();
    var type = els.type.value;

    var visible = assets.filter(function (asset) {
      if (type && asset.type !== type) return false;
      if (query && asset.name.toLowerCase().indexOf(query) < 0) return false;
      return true;
    });

    if (!visible.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = assets.length ? 'Ничего не найдено' : 'В бандле нет объектов';
      els.grid.appendChild(empty);
      return;
    }

    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        requestThumb(entry.target.dataset.pid);
      });
    }, { rootMargin: '300px' });

    var fragment = document.createDocumentFragment();

    visible.forEach(function (asset) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      card.dataset.pid = asset.pid;
      card.title = asset.name;

      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.dataset.pid = asset.pid;

      var url = thumbUrls.get(asset.pid);
      if (url) {
        thumb.appendChild(image(url));
        thumb.classList.add('ready');
      } else if (asset.error) {
        thumb.classList.add('broken');
        thumb.textContent = '!';
      } else {
        thumb.classList.add('pending');
        thumb.textContent = glyph(asset);
        observer.observe(thumb);
      }

      var caption = document.createElement('div');
      caption.className = 'caption';

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = asset.name;
      caption.appendChild(name);

      var sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = subtitle(asset);
      caption.appendChild(sub);

      card.appendChild(thumb);
      card.appendChild(caption);
      card.addEventListener('click', function () { openAsset(asset, card); });
      fragment.appendChild(card);
    });

    els.grid.appendChild(fragment);
  }

  function subtitle(asset) {
    var parts = [asset.type];
    if (asset.preview === 'image' && asset.width) {
      parts.push(asset.width + '×' + asset.height);
    }
    if (asset.bytes) parts.push(formatBytes(asset.bytes));
    return parts.join(' · ');
  }

  function glyph(asset) {
    if (asset.preview === 'image') return '▣';
    if (asset.preview === 'audio') return '♪';
    if (asset.preview === 'text') return '≣';
    return '·';
  }

  function image(url) {
    var img = document.createElement('img');
    img.src = url;
    img.loading = 'lazy';
    img.alt = '';
    return img;
  }

  /* ---------------------------------------------------------------- */
  /* миниатюры                                                         */
  /* ---------------------------------------------------------------- */

  function requestThumb(pid) {
    if (!pid || thumbUrls.has(pid)) return;
    if (thumbQueue.some(function (job) { return job.pid === pid; })) return;
    thumbQueue.push({ pid: pid, gen: generation });
    pumpThumbs();
  }

  function pumpThumbs() {
    while (thumbRunning < CONCURRENCY && thumbQueue.length) {
      var job = thumbQueue.shift();
      thumbRunning += 1;

      call('image', { pid: job.pid, max: THUMB })
        .then(function (message) {
          if (job.gen !== generation) return;
          var url = URL.createObjectURL(message.blob);
          thumbUrls.set(job.pid, url);
          els.grid.querySelectorAll('[data-pid="' + job.pid + '"] .thumb').forEach(function (thumb) {
            thumb.textContent = '';
            thumb.classList.remove('pending');
            thumb.classList.add('ready');
            thumb.appendChild(image(url));
          });
        })
        .catch(function () {
          els.grid.querySelectorAll('[data-pid="' + job.pid + '"] .thumb').forEach(function (thumb) {
            thumb.classList.remove('pending');
            thumb.classList.add('broken');
            thumb.textContent = '!';
          });
        })
        .then(function () {
          thumbRunning -= 1;
          pumpThumbs();
        });
    }
  }

  function clearThumbs() {
    thumbUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    thumbUrls.clear();
    thumbQueue.length = 0;
  }

  /* ---------------------------------------------------------------- */
  /* карточка ассета                                                   */
  /* ---------------------------------------------------------------- */

  async function openAsset(asset, card) {
    if (overlayUrl) {
      URL.revokeObjectURL(overlayUrl);
      overlayUrl = null;
    }

    els.overlay.hidden = false;
    els.preview.textContent = 'Загрузка…';
    els.preview.classList.remove('actual');
    els.zoom.hidden = asset.preview !== 'image';
    els.zoom.textContent = '1:1';
    els.zoom.setAttribute('aria-pressed', 'false');
    els.name.textContent = asset.name;
    els.download.hidden = true;
    fillMeta(asset);

    try {
      if (asset.preview === 'image') {
        var message = await call('image', { pid: asset.pid, max: 0 });
        var img = image(URL.createObjectURL(message.blob));
        overlayUrl = img.src;
        img.alt = asset.name;
        els.preview.textContent = '';
        els.preview.appendChild(img);
        setDownload(img.src, asset.name + '.png');
        if (message.width) {
          fillMeta(Object.assign({}, asset, { width: message.width, height: message.height, format: message.format }));
        }
      } else if (asset.preview === 'audio') {
        var audio = await call('audio', { pid: asset.pid });
        var url = URL.createObjectURL(audio.blob);
        overlayUrl = url;
        els.preview.textContent = '';
        var player = document.createElement('audio');
        player.controls = true;
        player.autoplay = true;
        player.src = url;
        els.preview.appendChild(player);
        if (audio.playable) setDownload(url, asset.name + '.' + audio.ext);
      } else if (asset.preview === 'text') {
        var text = await call('text', { pid: asset.pid });
        els.preview.textContent = '';
        var pre = document.createElement('pre');
        pre.textContent = text.text + (text.truncated ? '\n\n… (обрезано)' : '');
        els.preview.appendChild(pre);
        setDownload('data:text/plain;charset=utf-8,' + encodeURIComponent(text.text), asset.name + '.txt');
      } else {
        els.preview.textContent = 'Для этого типа объекта превью нет';
      }
    } catch (error) {
      els.preview.textContent = 'Не удалось показать: ' + error.message;
    }
  }

  function fillMeta(asset) {
    els.meta.textContent = '';
    [
      ['Тип', asset.type],
      ['Размер', asset.bytes ? formatBytes(asset.bytes) : '—'],
      ['Разрешение', asset.preview === 'image' && asset.width ? asset.width + '×' + asset.height : ''],
      ['Формат', asset.format || ''],
      ['Path', asset.path || '']
    ].forEach(function (row) {
      if (!row[1]) return;
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      dd.textContent = row[1];
      els.meta.appendChild(dt);
      els.meta.appendChild(dd);
    });
  }

  function setDownload(url, filename) {
    els.download.href = url;
    els.download.download = filename;
    els.download.hidden = false;
  }

  function closeOverlay() {
    els.overlay.hidden = true;
    els.preview.textContent = '';
    els.preview.classList.remove('actual');
    if (overlayUrl) {
      URL.revokeObjectURL(overlayUrl);
      overlayUrl = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* мелочи                                                            */
  /* ---------------------------------------------------------------- */

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showProgress(percent, text) {
    els.progress.hidden = false;
    els.bar.style.width = percent < 0 ? '100%' : percent + '%';
    els.bar.classList.toggle('unknown', percent < 0);
    if (text) setStatus(text);
  }

  function hideProgress() {
    els.progress.hidden = true;
    els.bar.style.width = '0';
  }

  function formatBytes(value) {
    if (!value) return '0 Б';
    if (value < 1024) return value + ' Б';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' КБ';
    return (value / (1024 * 1024)).toFixed(1) + ' МБ';
  }

  els.search.addEventListener('input', drawGrid);
  els.type.addEventListener('change', drawGrid);
  els.pixelated.addEventListener('change', applyPixelated);
  els.zoom.addEventListener('click', function () {
    var actual = els.preview.classList.toggle('actual');
    els.zoom.setAttribute('aria-pressed', actual ? 'true' : 'false');
    els.zoom.textContent = actual ? 'По размеру' : '1:1';
  });
  els.close.addEventListener('click', closeOverlay);
  els.overlay.addEventListener('click', function (event) {
    if (event.target === els.overlay) closeOverlay();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !els.overlay.hidden) closeOverlay();
  });
})();
