# tools

Исходник воркера просмотрщика. В рантайме не нужен: в `Github/` лежит уже
собранный `viewer-worker.js`, его и отдаёт GitHub Pages.

## Пересборка

```powershell
# один раз: esbuild и зависимости лежат в backup/node_modules
New-Item -ItemType Junction -Path tools\node_modules -Target backup\node_modules

# сборка
backup\node_modules\@esbuild\win32-x64\esbuild.exe tools\worker.js `
  --bundle --format=esm --minify --target=es2020 --outfile=Github\viewer-worker.js
```

WASM-декодер текстур (`texture2ddecoder.js` + `.wasm`) копируется из
`texture2ddecoder-wasm/wasm/` в `Github/wasm/`.

## Протокол воркера

| Запрос | Ответ |
| --- | --- |
| `{type:"load", name, data:ArrayBuffer}` | `{type:"loaded", info, assets}` |
| `{type:"image", pid, max}` | `{type:"image", blob, width, height}` |
| `{type:"audio", pid}` | `{type:"audio", blob, mime, ext}` |
| `{type:"text", pid}` | `{type:"text", text, truncated}` |

Ошибки: `{type:"error", id, message}`.
