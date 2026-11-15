# Bundles

Положите сюда файлы бандлов — просмотрщик сам найдёт их при загрузке страницы.

```
public/bundles/itemicons.webp
public/bundles/ui.webp
public/bundles/sounds.webp
```

Подходят файлы с расширениями `.webp`, `.bundle`, `.unity3d`, `.assets`, `.dat`, `.bin`.
Внутри должен быть UnityFS (или UnityWeb/gzip-обёртка) — расширение не важно.

## Список бандлов

По умолчанию просмотрщик проверяет известные имена игры (`itemicons`, `ui`, `hud`,
`atlases`, `zoomtextures`, `player_skins`, `actions`, `flags`, `quest`, `sounds`,
`generic_sounds`, `soundtrack`, `maintheme`, `season1`–`season4`, `unifiedraytracing`).

Если имена другие, создайте рядом файл `bundles.json`:

```json
{
  "bundles": [
    "itemicons.webp",
    "ui.webp",
    "subfolder/extra.bundle"
  ]
}
```

Можно и просто массивом:

```json
["itemicons.webp", "sounds.webp"]
```

Пути считаются относительно этой папки. Каждый файл проверяется запросом `HEAD`,
а первые 8 байт — запросом `Range`, чтобы не показывать в списке посторонние файлы.

Можно указать и готовый адрес — тогда файл берётся с чужого сервера (нужен прокси):

```json
{
  "bundles": [
    { "name": "itemicons.webp", "url": "https://blockade3d.com/ClassicBundles/itemicons.webp" },
    { "name": "ui.webp", "url": "https://blockade3d.com/ClassicBundles/ui.webp" }
  ]
}
```

Такую сборку делает `npm run pack -- --no-bundles`: локальные копии не кладутся,
а `bundles.json` указывает на сервер игры.

## Про CORS

Бандлы на этом же сайте читаются без настроек. Файлы с чужого домена браузер
прочитает только при наличии заголовка `Access-Control-Allow-Origin`; `blockade3d.com`
его не отдаёт. Поэтому в просмотрщике есть блок «Прокси для чужих серверов»:
PHP-скрипт `host/proxy.php` скачивает файл на сервере и отдаёт с вашего домена.
Без прокси остаётся локальный файл — он читается всегда.

## Пример

Готовый пример списка — в `bundles.example.json`. Скопируйте его в `bundles.json`
и поправьте имена.
