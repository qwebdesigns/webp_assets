# Bundle Viewer

Статический просмотрщик Unity AssetBundle: открывает `itemicons.webp`, `ui.webp`,
`sounds.webp` и другие бандлы **прямо в браузере** и показывает текстуры, звуки и текст.

- Никакого Python — статические файлы + маленький PHP-прокси (только если нужны
  бандлы с чужих серверов без CORS).
- Разбор UnityFS и декодирование DXT/BC/ETC/ASTC/**Crunch** выполняются на устройстве
  посетителя в Web Worker + WebAssembly.
- Файлы никуда не загружаются: сервер отдаёт только сам сайт.
- Локальный файл или drag & drop работают всегда, даже если у чужого сервера нет CORS.
- Кнопка **«Сервер игры»** берёт бандлы прямо с `blockade3d.com` через свой прокси,
  так что обновления игры подхватываются без ручной заливки файлов.

## Быстрый старт

```powershell
npm install
npm run dev      # http://localhost:5173
```

Продакшн-сборка и проверка:

```powershell
npm run build
npm run preview  # http://localhost:4173
```

Требуется Node.js 22.12+ (пакеты декодера объявляют такой диапазон в `engines`;
на 22.11 всё тоже работает, npm просто печатает предупреждение).

## Куда положить бандлы

Скопируйте файлы в `public/bundles/` — при сборке они попадут в `dist/bundles/`.

```
public/bundles/itemicons.webp
public/bundles/ui.webp
public/bundles/sounds.webp
```

Расширение не важно (`.webp`, `.bundle`, `.unity3d`, …), внутри должен быть UnityFS.
Если имена не совпадают с известными, создайте `public/bundles/bundles.json`:

```json
{
  "bundles": ["itemicons.webp", "ui.webp", "subfolder/extra.bundle"]
}
```

Подробности — в [`public/bundles/README.md`](public/bundles/README.md).

Для локальной проверки можно скачать настоящие бандлы BLOCKADE:

```powershell
npm run samples                  # itemicons, ui, sounds
npm run samples -- itemicons hud
```

По умолчанию эти файлы не попадают в git (`.gitignore`): это чужие ассеты.
Хотите показать их на своём сайте — уберите соответствующие строки из `.gitignore`
или добавьте исключения. Без бандлов сайт просто покажет экран «Откройте Unity AssetBundle».

## Деплой на свой хостинг (PHP)

Нужен любой хостинг с PHP 7.4+ и правом записи в папку (кэш прокси). Сборка папки:

```powershell
npm run pack                    # dist + host/ → upload/ и upload.zip (с бандлами, ~23 МБ)
npm run pack -- --no-bundles    # без бандлов, ~0.7 МБ; сайт берёт их с сервера игры
```

`upload/` — это содержимое папки сайта (например, `/webp_assets/`):

```
upload/index.html
upload/assets/…        скрипты Vite
upload/wasm/…          декодер текстур
upload/bundles/…       только при сборке с бандлами
upload/host/proxy.php  PHP-прокси
upload/host/cacert.pem CA-бандл для cURL (лечит «unable to get local issuer certificate»)
upload/host/.htaccess  запрещает отдачу .env и кэша
upload/host/.env.example
```

1. Залейте содержимое `upload/` в папку сайта (файловый менеджер хостинга или FTP).
2. Откройте `https://ваш-сайт/host/proxy.php?ping=1` — должен прийти JSON `"ok": true`
   с полями `curl`, `cache_writable`, `allowed_hosts`.
3. Откройте сайт, раскройте блок **«Прокси для чужих серверов»** (по умолчанию там
   `host/proxy.php`) и нажмите **«Проверить»** — появится «Прокси работает: …».
4. Нажмите **«Сервер игры»** — появятся 18 бандлов с меткой «сервер». Они качаются
   через ваш домен, кэшируются на сервере и открываются как обычно.

Настройки прокси — в `host/.env` (на сервере создайте файл из `.env.example`):

| Ключ | По умолчанию | Что делает |
|---|---|---|
| `PROXY_ALLOWED_HOSTS` | `blockade3d.com` | Белый список доменов, можно `*.example.com` |
| `PROXY_CACHE_TTL` | `3600` | Сколько секунд держать файл в `host/cache/` |
| `PROXY_MAX_BYTES` | `0` | Лимит размера файла, 0 — без лимита |
| `PROXY_TOKEN` | пусто | Токен доступа (`?token=…` или `X-Proxy-Token`) |
| `PROXY_CORS` | `*` | `Access-Control-Allow-Origin` для прокси |

Адрес прокси можно задать ссылкой: `?proxy=https://…/host/proxy.php` (или `?proxy=off`).
Он запоминается в `localStorage`. Флаг `&fresh=1` в запросе к прокси перекачивает файл
в обход кэша.

### Локальная проверка прокси

```powershell
php -S 127.0.0.1:8099 -t host    # отдельным окном
npm run dev                      # /host/proxy.php проксируется на этот PHP
```

## Деплой на GitHub Pages (необязательно)

1. Запушьте репозиторий на GitHub (ветка `main`).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) собирает сайт
   (`npm ci && npm run build`) и публикует `dist` при каждом пуше.

Прокси на Pages не работает (PHP нет), поэтому `host/proxy.php` вернёт 404, а кнопка
«Сервер игры» попросит включить прокси. Всё остальное — локальные файлы и своя папка
`bundles/` — работает.

`vite.config.js` использует `base: "./"`, поэтому сайт живёт и в корне домена, и в
подпапке `/<repo>/`, и пути к `wasm/` считаются от `document.baseURI`.

## Про CORS

Бандл читается через `fetch`, а браузер разрешает это только для своего origin или
при заголовке `Access-Control-Allow-Origin`. `blockade3d.com` такой заголовок не отдаёт,
поэтому напрямую ссылку `https://blockade3d.com/ClassicBundles/itemicons.webp` открыть
нельзя — просмотрщик попробует прокси и покажет понятную ошибку, если его нет.

Варианты:

- **прокси на своём хостинге** (`host/proxy.php`) — самый удобный: файлы всегда свежие,
  CORS не нужен, кэш снимает нагрузку с сервера игры;
- положить бандлы рядом с сайтом (`public/bundles/`) — тогда CORS не нужен вообще;
- скачать файл и открыть кнопкой «Файл…» или перетащить в окно — локальные файлы
  читаются всегда.

## Что умеет

- **Текстуры** → PNG: DXT1/3/5, BC4–BC7, ETC1/2, EAC, ASTC, PVRTC, ATC, Crunch.
  Превью декодируются лениво (IntersectionObserver), полный размер — по клику.
- **Звук**: AudioClip отдаётся как `<audio>` (AAC/m4a, Ogg, WAV, MP3; FSB5 — только скачивание).
- **Текст**: TextAsset показывается в модальном окне.
- Поиск по имени/пути, фильтр по типу, сортировка, размер превью, клавиши `/`, `←`, `→`, `Esc`.
- **ZIP**: все картинки/звуки/тексты плюс `_bundle-info.json`. Архив собирается в памяти
  и появляется кнопка «Скачать ZIP» — так браузер не блокирует скачивание, начатое
  после `await` без жеста пользователя.
- Ссылку можно шарить: `?src=https://…/itemicons.webp` открывает бандл сразу.
- **Прокси**: бандлы с чужих доменов качаются через `host/proxy.php`, кэшируются на
  сервере и обновляются сами; кнопка «Сервер игры» проверяет 18 бандлов BLOCKADE.

## Ограничения

- Читаются только ассеты с готовым предпросмотром (Texture2D/Sprite, AudioClip, TextAsset);
  меши, материалы, анимации, шейдеры видны в метаданных, но не отображаются.
- Из текстур берётся только первый mip-уровень; Cubemap/Array/3D не поддерживаются.
- Большие бандлы (сотни мегабайт) целиком лежат в памяти вкладки.
- ZIP-архив тоже собирается в памяти: на слабых устройствах экспорт большого бандла
  может занять время, прогресс и отмена есть в нижней панели.

## Структура

```
index.html            разметка интерфейса
src/main.js           UI, загрузка по ссылке/из файла, скан папки, прокси, ZIP
src/worker.js         Web Worker: разбор UnityFS, декодирование, экспорт
src/proxy.js          адреса прокси (общий модуль страницы и воркера)
src/imagecodec.js     PNG-энкодер, ресайз, определение формата аудио
src/style.css         тёмная адаптивная тема
public/wasm/          texture2ddecoder.js/.wasm (копируется из node_modules)
public/bundles/       ваши бандлы и bundles.json
host/                 PHP-прокси для чужих серверов (не коммитится, см. .gitignore)
scripts/fetch-samples.mjs  скачивание бандлов для локальных тестов
scripts/pack-host.mjs      сборка upload/ и upload.zip для хостинга
scripts/game-bundles.json  список бандлов игры для сборки без локальных копий
tools/python-viewer/  старая версия на Python + UnityPy (локальный сервер)
```

## Старая версия на Python

В [`tools/python-viewer/`](tools/python-viewer/) остался прежний просмотрщик
(`python viewer.py`), который качает бандл на своей стороне и потому обходит CORS.
Он больше не развивается, но может пригодиться как референс.

## Библиотеки

- [`unity-asset-reader`](https://www.npmjs.com/package/unity-asset-reader) — парсер UnityFS/SerializedFile.
- [`unity-asset-reader-texture`](https://www.npmjs.com/package/unity-asset-reader-texture) — `Texture2D`/`Sprite` → RGBA.
- [`texture2ddecoder-wasm`](https://www.npmjs.com/package/texture2ddecoder-wasm) — WASM-декодеры BC/ETC/ASTC/Crunch.
- [`fflate`](https://www.npmjs.com/package/fflate) — PNG (zlib) и ZIP.
