// Which pages agents may use in the user's Chrome: web pages only (http and https, localhost
// included). Browser pages (chrome://, chrome-extension://, devtools://, ...), local files
// and the Chrome Web Store are off limits. Pure functions, so they are unit tested.

const WEB_STORE_HOSTS = new Set(["chromewebstore.google.com"]);

/** True for an http(s) page agents may open, act on or claim. */
export function isWebUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (WEB_STORE_HOSTS.has(u.hostname)) return false;
  if (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore")) return false;
  return true;
}

/**
 * True when an agent may keep working in a tab it already owns that sits on `url`: web pages,
 * plus the blank page a new tab or popup shows before its first navigation commits.
 */
export function isUsableTabUrl(url: string): boolean {
  return !url || url === "about:blank" || isWebUrl(url);
}

/** Short human label for a URL in error messages: its origin, or the scheme for browser pages. */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    if (u.protocol === "file:") return "file://";
    return `${u.protocol}//${u.host}`;
  } catch {
    return JSON.stringify(url);
  }
}

export function notWebPageMessage(url: string): string {
  return (
    `T3 Browser only works with web pages (http and https). ${describeUrl(url)} is not one: ` +
    `browser pages, extension pages, local files and the Chrome Web Store are off limits. ` +
    `Ask the user to do this step themselves.`
  );
}

const LOCAL_HOST = /^(localhost|[^/?#:]+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:[/?#]|$)/i;

/**
 * Turn what an agent typed into a URL: "localhost:3000" -> http://localhost:3000,
 * "example.com" -> https://example.com. A real scheme ("chrome://", "file:") is kept as typed,
 * so isWebUrl can refuse it. "host:port" is a host, not a scheme.
 */
export function normalizeUrl(input: string): string {
  const url = input.trim();
  if (LOCAL_HOST.test(url)) return `http://${url}`;
  const scheme = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(url);
  if (scheme && !/^\d+(?:[/?#]|$)/.test(scheme[2])) return url;
  return `https://${url}`;
}
