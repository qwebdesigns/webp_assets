# API-тест

Минимальная проверка связки **GitHub Pages → PHP на своём хостинге → сервер игры**.

- `Github/` — статическая страница с одной кнопкой «Тест». Уходит в GitHub Pages.
- `Server/` — один PHP-скрипт `api.php`. Живёт на хостинге, в git не попадает.

Нажатие кнопки отправляет POST на `api.php`. Скрипт сам скачивает бандл с
`blockade3d.com`, читает заголовок UnityFS и возвращает JSON: размер, версию
Unity, сигнатуру, время ответа. Ни страница, ни хостинг ничего не сохраняют.

## Страница

https://qwebdesigns.github.io/webp_assets/

Адрес API задаётся в `Github/config.js`:

```js
window.API_URL = 'https://meowtech.bid/webp_assets/api.php';
```

Можно переопределить без правки файла: `?api=https://example.com/api.php`.

## Хостинг

Содержимое `Server/` (`api.php`, `.htaccess`, `cacert.pem`) заливается в
`public_html/meowtech.bid/webp_assets/`. Подробности — `Server/README.md`.

Проверка после загрузки: `https://meowtech.bid/webp_assets/api.php?ping=1`.

## Формат запроса

```json
POST api.php
Content-Type: application/json

{ "action": "test", "bundle": "itemicons" }
```

Ответ:

```json
{
  "ok": true,
  "api": "1.0",
  "bundle": {
    "name": "itemicons.webp",
    "httpStatus": 206,
    "bytes": 4096688,
    "unityVersion": "6000.3.5f2",
    "signature": "UnityFS",
    "formatVersion": 8,
    "isBundle": true
  },
  "timings": { "downloadMs": 210, "totalMs": 215 }
}
```

## Развёртывание

`.github/workflows/deploy.yml` публикует папку `Github/` на GitHub Pages при
пуше в `main`.

## Архив

Старая vite-версия лежит в `backup/` и в git не попадает.
