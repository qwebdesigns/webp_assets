(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var apiUrl = params.get('api') || window.API_URL || '';
  var bundle = params.get('bundle') || 'itemicons';

  var button = document.getElementById('test');
  var statusEl = document.getElementById('status');
  var table = document.getElementById('result');
  var tbody = table.querySelector('tbody');
  var rawBox = document.getElementById('raw-box');
  var rawEl = document.getElementById('raw');

  document.getElementById('api-url').textContent = apiUrl || '(не задан)';

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function render(data) {
    var rows = [];

    if (data && data.ok) {
      var b = data.bundle || {};
      rows.push(['Ответ', 'ok']);
      rows.push(['Бандл', b.name]);
      rows.push(['HTTP источника', b.httpStatus]);
      rows.push(['Размер', b.bytes != null ? b.bytes + ' байт' : '—']);
      rows.push(['Unity', b.unityVersion || '—']);
      rows.push(['Сигнатура', b.signature || '—']);
      rows.push(['Версия формата', b.formatVersion != null ? b.formatVersion : '—']);
      rows.push(['Это бандл', b.isBundle ? 'да' : 'нет']);
      rows.push(['Скачивание', (data.timings && data.timings.downloadMs) + ' мс']);
      rows.push(['Всего', (data.timings && data.timings.totalMs) + ' мс']);
      rows.push(['PHP', data.php]);
      setStatus('Успех', 'ok');
    } else {
      var err = (data && data.error) || {};
      rows.push(['Ответ', 'ошибка']);
      rows.push(['Код', err.code || '—']);
      rows.push(['Сообщение', err.message || 'неизвестная ошибка']);
      setStatus('Ошибка: ' + (err.message || 'неизвестная'), 'error');
    }

    tbody.textContent = '';
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.textContent = row[0];
      var td = document.createElement('td');
      td.textContent = row[1] == null ? '—' : String(row[1]);
      tr.appendChild(th);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });

    table.hidden = false;
    rawEl.textContent = JSON.stringify(data, null, 2);
    rawBox.hidden = false;
    rawBox.open = false;
  }

  button.addEventListener('click', function () {
    if (!apiUrl) {
      setStatus('Не задан адрес API в config.js', 'error');
      return;
    }

    button.disabled = true;
    table.hidden = true;
    rawBox.hidden = true;
    setStatus('Запрос к ' + apiUrl + ' …');

    var started = performance.now();

    fetch(apiUrl, {
      method: 'POST',
      // text/plain — «простой» запрос: браузер не делает preflight OPTIONS,
      // который хостинг обрывает. Тело всё равно JSON, PHP его разбирает сам.
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ action: 'test', bundle: bundle })
    })
      .then(function (res) {
        return res.text().then(function (text) {
          var data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            data = {
              ok: false,
              error: {
                code: 'bad_response_' + res.status,
                message: 'Ответ не JSON: ' + text.slice(0, 300)
              }
            };
          }
          render(data);
          setStatus(
            (data.ok ? 'Успех' : 'Ошибка') +
              ' · HTTP ' + res.status +
              ' · ' + Math.round(performance.now() - started) + ' мс',
            data.ok ? 'ok' : 'error'
          );
        });
      })
      .catch(function (err) {
        setStatus(
          'Сеть/CORS: ' + err.message + '. Проверьте адрес API и заголовки CORS на хостинге.',
          'error'
        );
      })
      .then(function () {
        button.disabled = false;
      });
  });
})();
