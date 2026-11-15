/**
 * Помощники для работы через PHP-прокси.
 *
 * Модуль общий: его импортирует и страница (src/main.js), и воркер
 * (src/worker.js), поэтому здесь нет обращений к DOM.
 *
 * Зачем прокси: сервер игры не отдаёт Access-Control-Allow-Origin, и браузер
 * не может прочитать бандл напрямую. Тогда тот же файл запрашивается у
 * host/proxy.php на нашем домене — CORS для same-origin не нужен.
 */

export const PROXY_STORAGE_KEY = "bundle-viewer:proxy";
export const DEFAULT_PROXY_PATH = "host/proxy.php";

/** Пустое значение, «off», «0» и т.п. означают «прокси выключен». */
export function normalizeProxy(value, base) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw || /^(off|none|no|false|0|-|нет|выкл)$/i.test(raw)) return "";
  try {
    const url = new URL(raw, base || self.location.href);
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

/** Адрес того же файла через прокси: <proxy>?url=<encodeURIComponent(target)>. */
export function proxiedUrl(proxy, target) {
  if (!proxy) return target;
  try {
    const url = new URL(proxy);
    url.searchParams.set("url", target);
    return url.href;
  } catch {
    return target;
  }
}

/** То же, но с ?info=1 — прокси ответит JSON с размером, не скачивая файл. */
export function proxyInfoUrl(proxy, target) {
  if (!proxy) return "";
  try {
    const url = new URL(proxy);
    url.searchParams.set("url", target);
    url.searchParams.set("info", "1");
    return url.href;
  } catch {
    return "";
  }
}

export function isCrossOrigin(target, base) {
  try {
    const origin = new URL(base || self.location.href).origin;
    return new URL(target, base || self.location.href).origin !== origin;
  } catch {
    return false;
  }
}
