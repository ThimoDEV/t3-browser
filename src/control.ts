// The control page: what each agent thread is doing in the user's Chrome, with Stop, from any
// device that can reach the daemon (this machine, or a phone over Tailscale). Served by the
// daemon at /control; authenticated with the daemon token once, then an HttpOnly cookie.

import { createHash, timingSafeEqual } from "node:crypto";
import type { SessionInfo } from "./protocol.js";

// ---- What happened, in words safe to show on a page ------------------------------------------

export interface ActivityEntry {
  at: number;
  text: string;
  ok: boolean;
  ms: number;
}

/** A URL without query or fragment: those often carry tokens or personal data. */
function where(url: unknown): string {
  try {
    const u = new URL(String(url));
    return u.origin + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return String(url ?? "").split(/[?#]/)[0].slice(0, 120);
  }
}

/**
 * One line per action the agent took, or undefined for reads that would only add noise.
 * Never includes typed text, eval code, file paths or URL queries.
 */
export function describeCall(method: string, p: Record<string, unknown> = {}): string | undefined {
  const n = (v: unknown) => (Array.isArray(v) ? v.length : v === undefined ? 0 : 1);
  switch (method) {
    case "tabs.open":
      return `opened ${where(p.url)}`;
    case "tabs.navigate":
      return p.action && p.action !== "goto" ? `went ${p.action}` : `went to ${where(p.url)}`;
    case "tabs.claim":
      return "took over one of your tabs";
    case "tabs.close":
      return "closed a tab";
    case "page.click":
      return `clicked ${p.ref ?? "a point"}`;
    case "page.type":
      return `typed ${String(p.text ?? "").length} characters${p.submit ? " and pressed Enter" : ""}`;
    case "page.press":
      return `pressed ${(Array.isArray(p.keys) ? p.keys : [p.keys]).map(String).join(" ").slice(0, 60)}`;
    case "page.select":
      return `chose ${n(p.values)} option(s)`;
    case "page.hover":
      return `hovered ${p.ref ?? ""}`.trim();
    case "page.scroll":
      return `scrolled ${p.direction ?? "to an element"}`;
    case "page.screenshot":
      return "took a screenshot";
    case "page.snapshot":
      return "read the page";
    case "page.read":
      return "read the page text";
    case "page.eval":
      return "ran a script on the page";
    case "page.wait":
      return "waited";
    case "page.upload":
      return `uploaded ${n(p.files) || n(p.inlineFiles)} file(s)`;
    case "page.dialog":
      return p.accept ? "accepted a dialog" : "dismissed a dialog";
    case "session.release":
      return "finished and handed the tabs back";
    case "session.stop":
      return "stopped from the control page";
    case "cdp.send":
      return `agent-browser: ${String(p.method ?? "")}`;
    default:
      return undefined;
  }
}

const PER_THREAD = 40;
const THREADS = 20;

export class ActivityLog {
  private threads = new Map<string, { info: SessionInfo; entries: ActivityEntry[]; last: number }>();

  record(info: SessionInfo, method: string, params: Record<string, unknown> | undefined, ok: boolean, ms: number, at = Date.now()): void {
    const text = describeCall(method, params);
    if (!text) return;
    let t = this.threads.get(info.id);
    if (!t) {
      if (this.threads.size >= THREADS) {
        const oldest = [...this.threads].sort((a, b) => a[1].last - b[1].last)[0];
        this.threads.delete(oldest[0]);
      }
      this.threads.set(info.id, (t = { info, entries: [], last: at }));
    }
    // Relay calls carry the id as the title; keep the better name.
    if (info.title && info.title !== info.id) t.info = { ...t.info, ...info };
    t.last = at;
    t.entries.unshift({ at, text, ok, ms });
    if (t.entries.length > PER_THREAD) t.entries.length = PER_THREAD;
  }

  threadsByRecency(): Array<{ info: SessionInfo; entries: ActivityEntry[]; last: number }> {
    return [...this.threads.values()].sort((a, b) => b.last - a.last);
  }
}

// ---- Auth -------------------------------------------------------------------------------------

export const CONTROL_COOKIE = "t3b_control";

/** Cookie value derived from the token, so it survives daemon restarts but not a new token. */
export function controlCookieValue(token: string): string {
  return createHash("sha256").update(`t3-browser control:${token}`).digest("hex");
}

export function sameSecret(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

// ---- The page -------------------------------------------------------------------------------------

export const CONTROL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>T3 Browser</title>
<link rel="stylesheet" href="/control/app.css">
</head>
<body>
<header><strong>T3 Browser</strong><span id="conn" class="status">…</span><button id="stop-all" class="danger" hidden>Stop all</button></header>
<main id="threads"><p class="muted">Loading…</p></main>
<dialog id="peek"><img alt="Screenshot of the agent's tab"><form method="dialog"><button>Close</button></form></dialog>
<script src="/control/app.js"></script>
</body>
</html>`;

export const CONTROL_CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#18151f;--muted:#6b6578;--line:#e7e3ee;--card:#f7f5fa;--accent:#6d4aff;--danger:#dc2626;--ok:#16a34a;font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#141219;--fg:#ece9f3;--muted:#9a93a8;--line:#2a2633;--card:#1c1924;--accent:#8b6cff;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;display:flex;gap:10px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--bg)}
header strong{flex:1}main{padding:12px 16px;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;max-width:760px;margin:0 auto}
.status{font-size:13px;color:var(--muted)}.status.on{color:var(--ok)}
.thread{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.row{display:flex;gap:8px;align-items:center}.row h2{flex:1;font-size:16px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
h2 a{color:inherit}.pill{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted)}.pill.on{color:var(--accent);border-color:var(--accent)}
ul{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:4px}li{font-size:13px;color:var(--muted);display:flex;gap:8px}
li .t{flex:none;width:36px;font-variant-numeric:tabular-nums}li.err{color:var(--danger)}.tab{color:var(--fg)}.tab span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{font:inherit;font-size:13px;font-weight:600;border-radius:8px;padding:6px 12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button.danger{background:var(--danger);border-color:var(--danger);color:#fff}button.small{padding:2px 8px;font-size:12px}
.muted{color:var(--muted)}dialog{max-width:96vw;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--fg)}dialog img{max-width:100%;display:block;margin-bottom:8px}`;

export const CONTROL_JS = `(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); n.append(...kids); return n; };
  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : Math.round(s / 3600) + "h"; };
  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-t3-browser": "1" }, body: JSON.stringify(body) }).then((r) => r.json());

  async function peek(session, tabId) {
    const r = await post("/control/peek", { session, tabId });
    if (r.error) return alert(r.error);
    const d = $("#peek"); d.querySelector("img").src = "data:" + r.mimeType + ";base64," + r.data; d.showModal();
  }

  // What the page last showed: Stop all must stop every thread it showed as running.
  let shown = [];
  const UNREACHABLE = { stopped: [], error: "Could not reach T3 Browser on your computer." };

  /** Stop threads; tell the user plainly about any that did not stop. */
  async function stop_(body, expected) {
    const r = await post("/control/stop", body).catch(() => UNREACHABLE);
    const stopped = Array.isArray(r.stopped) ? r.stopped : [];
    const missed = expected.filter((t) => !stopped.includes(t.id));
    if (missed.length) {
      alert("Could not stop " + missed.map((t) => "\u201c" + t.title + "\u201d").join(", ") + ". " + (r.error || "Is Chrome connected?") + " Press Esc in the agent's tab, or close it.");
    }
    render();
  }

  async function render() {
    let state;
    try { state = await (await fetch("/control/state")).json(); } catch { $("#conn").textContent = "daemon unreachable"; $("#conn").className = "status"; return; }
    if (state.error) { location.reload(); return; }
    $("#conn").textContent = state.extensionConnected ? "Chrome connected" : "Chrome not connected";
    $("#conn").className = "status" + (state.extensionConnected ? " on" : "");
    shown = state.threads;
    $("#stop-all").hidden = !state.threads.some((t) => t.controlling);
    const main = $("#threads"); main.replaceChildren();
    if (!state.threads.length) main.append(el("p", { class: "muted" }, "No agent has used the browser since the daemon started."));
    for (const t of state.threads) {
      const title = t.link ? el("a", { href: t.link, target: "_blank", rel: "noreferrer" }, t.title) : t.title;
      const stop = el("button", { class: "danger small" }, "Stop");
      stop.onclick = async () => {
        stop.disabled = true;
        await stop_({ session: t.id }, [t]);
      };
      if (!t.controlling) stop.hidden = true;
      const tabs = el("ul");
      for (const tab of t.tabs) {
        const b = el("button", { class: "small" }, "Peek"); b.onclick = () => peek(t.id, tab.tabId);
        tabs.append(el("li", { class: "tab" }, el("span", { title: tab.url }, tab.title || tab.url), b));
      }
      const acts = el("ul");
      for (const a of t.activity.slice(0, 12)) acts.append(el("li", { class: a.ok ? "" : "err" }, el("span", { class: "t" }, ago(a.at)), el("span", {}, a.text + (a.ok ? "" : " (failed)"))));
      main.append(el("section", { class: "thread" },
        el("div", { class: "row" }, el("h2", {}, title), el("span", { class: "pill" + (t.connected ? " on" : "") }, t.connected ? "agent connected" : "agent gone"), stop),
        tabs, acts));
    }
  }

  $("#stop-all").onclick = async () => {
    $("#stop-all").disabled = true;
    await stop_({}, shown.filter((t) => t.controlling));
    $("#stop-all").disabled = false;
  };
  render();
  setInterval(render, 2000);
})();`;
