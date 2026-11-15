# Bundle Viewer

Статический просмотрщик Unity AssetBundle: открывает `itemicons.webp`, `ui.webp`,
`sounds.webp` и другие бандлы **прямо в браузере** и показывает текстуры, звуки и текст.

- Никакого бэкенда и Python — только статические файлы (Vite → GitHub Pages).
- Разбор UnityFS и декодирование DXT/BC/ETC/ASTC/**Crunch** выполняются на устройстве
  посетителя в Web Worker + WebAssembly.
- Файлы никуда не загружаются: сервер отдаёт только сам сайт.
- Локальный файл или drag & drop работают всегда, даже если у чужого сервера нет CORS.

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

## Деплой на GitHub Pages

1. Запушьте репозиторий на GitHub (ветка `main`).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Готовый workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
   собирает сайт (`npm ci && npm run build`) и публикует `dist` при каждом пуше.

`vite.config.js` использует `base: "./"`, поэтому сайт работает и в корне домена,
и в подпапке `/<repo>/`, и пути к `wasm/` считаются от `document.baseURI`.

## Про CORS

Бандл читается через `fetch`, а браузер разрешает это только для своего origin или
при заголовке `Access-Control-Allow-Origin`. `blockade3d.com` такой заголовок не отдаёт,
поэтому ссылку `https://blockade3d.com/ClassicBundles/itemicons.webp` открыть нельзя —
просмотрщик покажет понятную ошибку и подсказку.

Варианты:

- положить бандлы рядом с сайтом (`public/bundles/`) — тогда CORS не нужен;
- скачать файл и открыть кнопкой «Файл…» или перетащить в окно — локальные файлы
  читаются всегда;
- поднять свой прокси/хранилище с `Access-Control-Allow-Origin`.

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
src/main.js           UI, загрузка по ссылке/из файла, скан папки, ZIP
src/worker.js         Web Worker: разбор UnityFS, декодирование, экспорт
src/imagecodec.js     PNG-энкодер, ресайз, определение формата аудио
src/style.css         тёмная адаптивная тема
public/wasm/          texture2ddecoder.js/.wasm (копируется из node_modules)
public/bundles/       ваши бандлы и bundles.json
scripts/fetch-samples.mjs
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
