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

## Про CORS

Если бандлы лежат на этом же сайте (например, в этом репозитории на GitHub Pages),
всё работает без настроек. Файлы с чужого домена браузер прочитает только при наличии
заголовка `Access-Control-Allow-Origin`; иначе скачайте файл и перетащите его в окно
просмотрщика — локальные файлы читаются всегда.

## Пример

Готовый пример списка — в `bundles.example.json`. Скопируйте его в `bundles.json`
и поправьте имена.
