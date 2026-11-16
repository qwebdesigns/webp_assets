# BLOCKADE asset viewer

Просмотр ассетов игры BLOCKADE прямо в браузере: страница на GitHub Pages,
данные — с официального сервера игры через PHP-прокси на своём хостинге.
Бандлы нигде не сохраняются: PHP стримит файл в браузер, браузер разбирает его
в воркере.

- `Github/` — статическая страница. Уходит в GitHub Pages как есть.
- `Server/` — один PHP-файл `api.php`. Живёт на хостинге, в git не попадает.

## Страница

https://qwebdesigns.github.io/webp_assets/

Что умеет:

- 23 бандла списком (имена как в `BLOCKADE/AssetBundles`);
- сетка ассетов с ленивыми превью, поиском по имени и фильтром по типу;
- пиксель-пёрфект рендеринг (`image-rendering: pixelated`, чекбокс в тулбаре);
- карточка ассета: полное изображение с режимом 1:1, звук, текст, скачивание.

Адрес API задаётся в `Github/config.js`, можно переопределить через `?api=`.

## API

`Server/api.php`, константы в начале файла.

| Запрос | Ответ |
| --- | --- |
| `GET ?ping=1` | диагностика: PHP, cURL, CA, список бандлов |
| `GET ?bundles=1` | список доступных бандлов |
| `GET ?bundle=itemicons` | бинарный поток бандла (`application/octet-stream`) |
| `POST {"action":"test","bundle":"itemicons"}` | заголовок UnityFS в JSON |

Скачивание бандла — потоком: cURL читает с `blockade3d.com` и сразу пишет
клиенту, на диск ничего не попадает (`Content-Length` берётся из заголовков
источника, `X-Accel-Buffering: no` отключает буферизацию nginx).

Белый список имён — `const BUNDLES`, открытым прокси скрипт не станет.

## Структура

```
Github/            index.html, app.js, style.css, config.js
                   viewer-worker.js  — собранный воркер (парсер + декодер)
                   wasm/             — декодер текстур
Server/            api.php, .htaccess, cacert.pem  (в git не попадает)
tools/             исходник воркера и инструкция по пересборке
backup/            старая vite-версия (в git не попадает)
```

Воркер собирается заранее и лежит готовым файлом — сборки на GitHub Pages нет.
Как пересобрать: `tools/README.md`.

## Развёртывание

1. Залить `Server/api.php`, `Server/.htaccess`, `Server/cacert.pem` в
   `public_html/meowtech.bid/webp_assets/` (перезаписать старые).
2. Проверить `https://meowtech.bid/webp_assets/api.php?ping=1`.
3. Пуш в `main` — workflow `.github/workflows/deploy.yml` публикует `Github/`.
