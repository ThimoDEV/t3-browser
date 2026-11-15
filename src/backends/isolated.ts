// "Isolated" browser: a separate, clean Chrome driven by Vercel's agent-browser CLI.
// No access to the user's cookies or tabs, can run headless.
// Each agent thread gets its own agent-browser --session.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export class IsolatedError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function agentBrowserBin(): { cmd: string; prefix: string[] } {
  if (process.env.T3_BROWSER_AGENT_BROWSER) return { cmd: process.env.T3_BROWSER_AGENT_BROWSER, prefix: [] };
  try {
    const pkgPath = require.resolve("agent-browser/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["agent-browser"];
    if (bin) return { cmd: process.execPath, prefix: [join(dirname(pkgPath), bin)] };
  } catch {
    // fall back to PATH
  }
  return { cmd: "agent-browser", prefix: [] };
}

function systemChrome(): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [
          join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
          join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
          join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
          join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((p) => p && existsSync(p));
}

interface AbResult<T = any> {
  success: boolean;
  data?: T;
  error?: string | { message?: string; code?: string } | null;
}

export class IsolatedBrowser {
  private readonly session: string;
  private currentTab: string | null = null;
  private launched = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(threadId: string) {
    this.session = `t3-${threadId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "thread"}`;
  }

  private exec<T = any>(args: string[], timeoutMs = 60_000): Promise<T> {
    const { cmd, prefix } = agentBrowserBin();
    const env = { ...process.env };
    if (!env.AGENT_BROWSER_EXECUTABLE_PATH) {
      const chrome = systemChrome();
      if (chrome) env.AGENT_BROWSER_EXECUTABLE_PATH = chrome;
    }
    return new Promise((resolve, reject) => {
      execFile(
        cmd,
        [...prefix, "--session", this.session, "--json", ...args],
        { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          const text = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
          if (text) {
            try {
              const res = JSON.parse(text) as AbResult<T>;
              if (res.success) return resolve(res.data as T);
              const e = res.error;
              const message = typeof e === "string" ? e : (e?.message ?? "agent-browser command failed");
              return reject(new IsolatedError(message, typeof e === "object" && e ? e.code : undefined));
            } catch {
              // fall through
            }
          }
          if (err) {
            const hint = /ENOENT/.test(String(err)) ? " (is agent-browser installed? `npm i -g agent-browser`)" : "";
            return reject(new IsolatedError(`agent-browser failed: ${(stderr || err.message).trim()}${hint}`));
          }
          resolve(undefined as T);
        },
      );
    });
  }

  /** agent-browser keeps one "current tab" per session; serialise commands and switch first. */
  private run<T = any>(tab: string | undefined, args: string[], timeoutMs?: number): Promise<T> {
    const job = this.queue.then(async () => {
      if (tab && tab !== this.currentTab) {
        await this.exec(["tab", tab]);
        this.currentTab = tab;
      }
      return this.exec<T>(args, timeoutMs);
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async open(url: string, headed = false): Promise<{ tab: string; url: string; title: string }> {
    if (!this.launched) {
      const flags = headed ? ["--headed"] : [];
      const data = await this.run(undefined, [...flags, "open", url]);
      this.launched = true;
      const tabs = await this.tabs();
      const active = tabs.find((t) => t.active) ?? tabs[tabs.length - 1];
      this.currentTab = active?.id ?? null;
      return { tab: active?.id ?? "t1", url: data?.url ?? url, title: data?.title ?? "" };
    }
    await this.run(undefined, ["tab", "new", url]);
    const tabs = await this.tabs();
    const active = tabs.find((t) => t.active) ?? tabs[tabs.length - 1];
    this.currentTab = active?.id ?? null;
    return { tab: active.id, url: active.url, title: active.title };
  }

  async tabs(): Promise<Array<{ id: string; url: string; title: string; active: boolean }>> {
    if (!this.launched) return [];
    const data = await this.exec<any>(["tab", "list"]);
    const list: any[] = Array.isArray(data) ? data : (data?.tabs ?? []);
    return list.map((t, i) => ({
      id: String(t.id ?? t.tabId ?? `t${i + 1}`),
      url: String(t.url ?? ""),
      title: String(t.title ?? ""),
      active: !!(t.active ?? t.current ?? t.selected),
    }));
  }

  navigate(tab: string, action: string, url?: string) {
    if (action === "goto") return this.run(tab, ["open", url!]);
    return this.run(tab, [action]);
  }

  snapshot(tab: string, o: { interactive?: boolean; selector?: string; maxDepth?: number }) {
    const args = ["snapshot"];
    if (o.interactive) args.push("-i");
    if (o.selector) args.push("-s", o.selector);
    if (o.maxDepth !== undefined) args.push("-d", String(o.maxDepth));
    return this.run<{ snapshot: string; origin?: string }>(tab, args);
  }

  click(tab: string, ref: string, doubleClick?: boolean) {
    return this.run(tab, [doubleClick ? "dblclick" : "click", at(ref)]);
  }

  hover(tab: string, ref: string) {
    return this.run(tab, ["hover", at(ref)]);
  }

  async type(tab: string, ref: string | undefined, text: string, clear = true, submit = false) {
    if (ref) await this.run(tab, [clear ? "fill" : "type", at(ref), text]);
    else await this.run(tab, ["keyboard", "inserttext", text]);
    if (submit) await this.run(tab, ["press", "Enter"]);
    return this.run(tab, ["get", "url"]);
  }

  async press(tab: string, keys: string[]) {
    for (const k of keys) await this.run(tab, ["press", k]);
    return this.run(tab, ["get", "url"]);
  }

  scroll(tab: string, direction?: string, amount?: number, ref?: string) {
    if (ref && !direction) return this.run(tab, ["scrollintoview", at(ref)]);
    return this.run(tab, ["scroll", direction ?? "down", String(amount ?? 600)]);
  }

  select(tab: string, ref: string, values: string[]) {
    return this.run(tab, ["select", at(ref), ...values]);
  }

  async screenshot(tab: string, fullPage?: boolean): Promise<{ data: string; mimeType: string }> {
    const dir = mkdtempSync(join(tmpdir(), "t3-browser-shot-"));
    const file = join(dir, "shot.png");
    try {
      await this.run(tab, ["screenshot", ...(fullPage ? ["--full"] : []), file]);
      return { data: readFileSync(file).toString("base64"), mimeType: "image/png" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async read(tab: string, selector?: string, offset = 0, maxChars = 20_000) {
    const expr = selector
      ? `(document.querySelector(${JSON.stringify(selector)})||{}).innerText||""`
      : "document.body ? document.body.innerText : ''";
    const data = await this.run(tab, ["eval", expr]);
    const text = String(data?.result ?? data?.value ?? data ?? "").replace(/\n{3,}/g, "\n\n");
    return {
      text: text.slice(offset, offset + maxChars),
      totalChars: text.length,
      ...(offset + maxChars < text.length ? { nextOffset: offset + maxChars } : {}),
    };
  }

  async eval(tab: string, expression: string) {
    const data = await this.run(tab, ["eval", expression]);
    return { value: data?.result ?? data?.value ?? data };
  }

  wait(tab: string, o: { text?: string; selector?: string; urlIncludes?: string; gone?: boolean; ms?: number; timeoutMs?: number }) {
    const t = String(o.timeoutMs ?? 10_000);
    const timeout = (o.timeoutMs ?? 10_000) + 5_000;
    if (o.text && o.gone) return this.run(tab, ["wait", "--fn", `!document.body.innerText.includes(${JSON.stringify(o.text)})`, "--timeout", t], timeout);
    if (o.text) return this.run(tab, ["wait", "--text", o.text, "--timeout", t], timeout);
    if (o.selector) return this.run(tab, ["wait", o.selector, ...(o.gone ? ["--state", "hidden"] : []), "--timeout", t], timeout);
    if (o.urlIncludes) return this.run(tab, ["wait", "--url", `**${o.urlIncludes}**`, "--timeout", t], timeout);
    if (o.ms) return this.run(tab, ["wait", String(o.ms)], o.ms + 5_000);
    return this.run(tab, ["wait", "--load", "load", "--timeout", t], timeout);
  }

  upload(tab: string, ref: string, files: string[]) {
    return this.run(tab, ["upload", at(ref), ...files]);
  }

  dialog(tab: string, accept: boolean, promptText?: string) {
    return this.run(tab, accept ? ["dialog", "accept", ...(promptText ? [promptText] : [])] : ["dialog", "dismiss"]);
  }

  async closeTab(tab: string) {
    await this.run(undefined, ["tab", "close", tab]);
    if (this.currentTab === tab) this.currentTab = null;
  }

  async close() {
    if (!this.launched) return;
    await this.run(undefined, ["close"]).catch(() => {});
    this.launched = false;
    this.currentTab = null;
  }
}

const at = (ref: string) => (ref.startsWith("@") ? ref : `@${ref.replace(/^ref=/, "")}`);
