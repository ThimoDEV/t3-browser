// The bridge daemon: one per machine, shared by every agent thread.
//
//   MCP server (per thread) ──ws /client──┐
//   agent-browser connect ──ws /cdp/<id>──┼── daemon ──ws /extension── Chrome extension
//
// The extension is authenticated by its Origin (chrome-extension://<pinned id>), which a web
// page cannot forge. Local clients present the token from ~/.t3-browser/token, and any
// connection carrying a web Origin is refused, so a page cannot drive the browser even if it
// learns the port.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { CdpRelay } from "./cdp-relay.js";
import { CallStats } from "./stats.js";
import { ActivityLog, CONTROL_COOKIE, CONTROL_CSS, CONTROL_HTML, CONTROL_JS, controlCookieValue, readCookie, sameSecret } from "./control.js";
import { checkListenAddress, isLoopbackAddress, materializeUploads, readDaemonConfig, type InlineFile } from "./remote.js";
import { DAEMON_FILE, HOME, LOG_FILE, PORT, ensureHome, readOrCreateToken } from "./paths.js";
import {
  EXTENSION_ID,
  PROTOCOL_VERSION,
  type EventMessage,
  type RequestMessage,
  type ResponseMessage,
  type SessionInfo,
  type WireMessage,
} from "./protocol.js";
import { localT3Cli, sendToThread } from "./t3thread.js";
import { VERSION } from "./version.js";

const EXTENSION_WAIT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 120_000;
const IDLE_EXIT_MS = 30 * 60_000;
/** Calls slower than this are written to the log (all calls are counted in the stats). */
const SLOW_CALL_MS = 5_000;
/** A thread whose MCP server and CDP clients are all gone this long gets its tabs released. */
const RELEASE_AFTER_MS = Number(process.env.T3_BROWSER_RELEASE_AFTER_MS) || 120_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let linesSinceSizeCheck = 0;

function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  try {
    if (++linesSinceSizeCheck >= 200) {
      linesSinceSizeCheck = 0;
      try {
        if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
      } catch {
        // missing or locked log file: just keep appending
      }
    }
    appendFileSync(LOG_FILE, line);
  } catch {
    // logging must never take the daemon down
  }
  if (process.env.T3_BROWSER_DEBUG) process.stderr.write(line);
}

export function allowedExtensionOrigins(): Set<string> {
  const ids = [EXTENSION_ID, ...(process.env.T3_BROWSER_EXTENSION_IDS ?? "").split(",").filter(Boolean)];
  return new Set(ids.map((id) => `chrome-extension://${id.trim()}`));
}

/** Local clients must present the token and must not come from a web page. */
export function isAuthorizedClient(req: IncomingMessage, token: string): boolean {
  const origin = req.headers.origin;
  if (origin && !allowedExtensionOrigins().has(origin)) return false;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const presented = url.searchParams.get("token") ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
  // Constant-time: the daemon may be reachable from other machines (see remote.ts).
  return sameSecret(presented ?? undefined, token);
}

interface Pending {
  resolve: (msg: ResponseMessage) => void;
  timer: NodeJS.Timeout;
}

export class Daemon {
  private extension: WebSocket | null = null;
  private extensionInfo: { version?: string; userAgent?: string } = {};
  private extensionWaiters: Array<() => void> = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private clients = new Set<WebSocket>();
  private relays = new Set<CdpRelay>();
  readonly stats = new CallStats();
  readonly activity = new ActivityLog();
  /** Extra private addresses the daemon also listens on (Tailscale, LAN), for remote agents. */
  readonly listen: string[] = [];
  /** Remote use is set up: stay up even with no clients, so remote agents and the phone can connect. */
  private remoteConfigured = false;
  /**
   * Which thread each MCP connection serves, to notice when a thread has gone away. CDP relay
   * clients do not count: agent-browser keeps its relay socket open after the agent is gone.
   */
  private connectionSession = new Map<WebSocket, string>();
  /** Threads that have used the user's browser and not released it yet. */
  private activeSessions = new Map<string, SessionInfo>();
  private releaseTimers = new Map<string, NodeJS.Timeout>();
  private idleTimer: NodeJS.Timeout | null = null;
  readonly token = readOrCreateToken();

  constructor(private readonly port = PORT) {}

  async start(): Promise<void> {
    ensureHome();
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    const onUpgrade = (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
      const path = parsePath(req.url);
      if (path === undefined) {
        socket.destroy();
        return;
      }
      if (path === "/extension") {
        // Chrome runs next to its daemon; nothing from another machine may pose as it.
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          log("rejected extension connection from", req.socket.remoteAddress ?? "?");
          socket.destroy();
          return;
        }
        if (!allowedExtensionOrigins().has(req.headers.origin ?? "")) {
          log("rejected extension connection from origin", req.headers.origin ?? "(none)");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => void this.acceptExtension(ws));
        return;
      }
      if (path === "/client" || path.startsWith("/cdp/")) {
        if (!isAuthorizedClient(req, this.token)) {
          log("rejected unauthorized client on", path);
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (path === "/client") this.onClient(ws);
          else this.onCdp(ws, decodeURIComponent(path.slice("/cdp/".length)));
        });
        return;
      }
      socket.destroy();
    };
    const serve = (host: string) =>
      new Promise<void>((resolve, reject) => {
        const http = createServer((req, res) => {
          this.onHttp(req, res).catch((err) => {
            log("http handler error", String((err as Error)?.message ?? err));
            if (!res.headersSent) res.writeHead(500);
            res.end();
          });
        });
        http.on("upgrade", onUpgrade);
        http.once("error", reject);
        http.listen(this.port, host, () => resolve());
      });

    await serve("127.0.0.1");
    // Files a remote agent uploaded before a restart are no longer needed.
    rmSync(join(HOME, "uploads"), { recursive: true, force: true });
    // Remote agents: only specific private addresses, and a failure there never takes the
    // local daemon down. Tailscale may come up after the daemon, so failed ones are retried.
    const wanted = readDaemonConfig().listen.filter((host) => {
      const problem = checkListenAddress(host);
      if (problem) log("not listening on", host, problem);
      return !problem;
    });
    this.remoteConfigured = wanted.length > 0;
    const tryListen = async () => {
      for (const host of wanted) {
        if (this.listen.includes(host)) continue;
        try {
          await serve(host.replace(/^\[|\]$/g, ""));
          this.listen.push(host);
          log("now also listening on", `${host}:${this.port}`);
        } catch (err) {
          log("could not listen on", host, String((err as Error).message ?? err));
        }
      }
      writeFileSync(DAEMON_FILE, JSON.stringify({ pid: process.pid, port: this.port, version: VERSION, listen: this.listen }, null, 2));
    };
    await tryListen();
    if (wanted.some((h) => !this.listen.includes(h))) {
      const retry = setInterval(() => {
        if (wanted.every((h) => this.listen.includes(h))) clearInterval(retry);
        else void tryListen();
      }, 60_000);
      retry.unref();
    }
    log(`daemon ${VERSION} listening on ${["127.0.0.1", ...this.listen].map((h) => `${h}:${this.port}`).join(", ")}`);
    this.bumpIdle();
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (url.pathname === "/control" || url.pathname.startsWith("/control/")) {
      await this.onControl(req, res, url).catch((err) => {
        log("control page error", String((err as Error).message ?? err));
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      });
      return;
    }
    if (url.pathname === "/health") {
      // Deliberately reveals nothing beyond "is this our daemon and is Chrome attached".
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name: "t3-browser",
          version: VERSION,
          protocol: PROTOCOL_VERSION,
          extensionConnected: this.extension?.readyState === WebSocket.OPEN,
        }),
      );
      return;
    }
    // CDP discovery for tools that want an http:// endpoint (`/cdp/<session>/json/version`).
    const m = url.pathname.match(/^\/cdp\/([^/]+)\/json\/version$/);
    if (m && isAuthorizedClient(req, this.token)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          Browser: `Chrome/t3-browser-relay`,
          "Protocol-Version": "1.3",
          "User-Agent": this.extensionInfo.userAgent ?? "",
          // The address the client reached us on (a remote agent cannot use our 127.0.0.1).
          webSocketDebuggerUrl: `ws://${this.allowedHost(req) ? req.headers.host : `127.0.0.1:${this.port}`}/cdp/${m[1]}?token=${this.token}`,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  }

  // ---- Control page (/control) ------------------------------------------------------------
  // Open once with ?token=<daemon token> (`t3-browser control` prints the link); that sets an
  // HttpOnly, SameSite=Strict cookie. Actions are POSTs with a custom header, which a page on
  // another origin cannot send without a CORS preflight the daemon never approves.

  private allowedHost(req: IncomingMessage): boolean {
    // Against DNS rebinding: only the addresses the daemon really listens on.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    return ["127.0.0.1", "localhost", "::1", ...this.listen.map((h) => h.replace(/^\[|\]$/g, "").toLowerCase())].includes(host);
  }

  private async onControl(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ...extra,
      });
      res.end(body);
    };
    const json = (status: number, v: unknown) => send(status, "application/json", JSON.stringify(v));
    if (!this.allowedHost(req)) return json(421, { error: "unknown host" });

    if (url.pathname === "/control/app.js") return send(200, "text/javascript; charset=utf-8", CONTROL_JS);
    if (url.pathname === "/control/app.css") return send(200, "text/css; charset=utf-8", CONTROL_CSS);

    const cookie = controlCookieValue(this.token);
    if (url.pathname === "/control" && url.searchParams.has("token")) {
      if (!sameSecret(url.searchParams.get("token") ?? undefined, this.token)) return send(401, "text/plain", "Wrong token. Run `t3-browser control` for a fresh link.");
      // Swap the token in the address bar for a cookie, so it does not linger in history.
      return send(302, "text/plain", "", {
        location: "/control",
        // Lax, so the link also works when opened from chat or mail; actions need the custom
        // header and a same-origin Origin anyway.
        "set-cookie": `${CONTROL_COOKIE}=${cookie}; HttpOnly; SameSite=Lax; Path=/control; Max-Age=2592000`,
      });
    }
    if (!sameSecret(readCookie(req.headers.cookie, CONTROL_COOKIE), cookie)) {
      return url.pathname === "/control" ? send(401, "text/plain", "Open the link that `t3-browser control` prints.") : json(401, { error: "not signed in" });
    }

    if (req.method === "GET" && url.pathname === "/control") return send(200, "text/html; charset=utf-8", CONTROL_HTML);
    if (req.method === "GET" && url.pathname === "/control/state") return json(200, await this.controlState());

    if (req.method === "POST" && (url.pathname === "/control/stop" || url.pathname === "/control/peek" || url.pathname === "/control/handback")) {
      const origin = req.headers.origin;
      if (req.headers["x-t3-browser"] !== "1" || (origin && origin !== `http://${req.headers.host}`)) return json(403, { error: "forbidden" });
      const body = (await readJson(req)) as { session?: string; tabId?: number; note?: string };
      if (url.pathname === "/control/stop") {
        // Without Chrome nothing can be stopped: say so at once instead of waiting for it per thread.
        if (this.extension?.readyState !== WebSocket.OPEN) {
          return json(200, { stopped: [], error: "Chrome is not connected to T3 Browser, so nothing was stopped." });
        }
        const targets = body.session ? [body.session] : [...this.activeSessions.keys()];
        const stopped: string[] = [];
        let failure: string | undefined;
        for (const id of targets) {
          const info = this.activeSessions.get(id);
          if (!info) continue;
          const r = await this.forward(info, "session.stop", {});
          this.activity.record(info, "session.stop", {}, !r.error, 0);
          if (!r.error) stopped.push(id);
          else failure ??= r.error.message;
        }
        return json(200, failure ? { stopped, error: failure } : { stopped });
      }
      const info = body.session ? this.activeSessions.get(body.session) : undefined;
      if (!info) return json(404, { error: "That thread has no tabs any more." });
      if (url.pathname === "/control/handback") {
        // The extension posts the note (thread.send above), so the page and the phone take one path.
        const r = await this.forward(info, "session.handback", { note: String(body.note ?? "").slice(0, 2_000) });
        return r.error ? json(200, { error: r.error.message }) : json(200, r.result);
      }
      const r = await this.forward(info, "page.peek", { tabId: Number(body.tabId) });
      return r.error ? json(200, { error: r.error.message }) : json(200, r.result);
    }
    return json(404, { error: "not found" });
  }

  private async controlState() {
    const extensionConnected = this.extension?.readyState === WebSocket.OPEN;
    const live = new Set(this.connectionSession.values());
    const threads = new Map<string, { info: SessionInfo; activity: unknown[] }>();
    for (const t of this.activity.threadsByRecency()) threads.set(t.info.id, { info: t.info, activity: t.entries });
    for (const [id, info] of this.activeSessions) if (!threads.has(id)) threads.set(id, { info, activity: [] });
    const out = [];
    for (const [id, { info, activity }] of threads) {
      const current = this.activeSessions.get(id) ?? info;
      let tabs: Array<{ tabId: number; title: string; url: string }> = [];
      let yourTurn: { ask?: string } | undefined;
      if (this.activeSessions.has(id) && extensionConnected) {
        const r = await this.forward(current, "status", {});
        const st = r.result as { tabs?: Array<{ tabId: number; title: string; url: string }>; session?: { handback?: { ask?: string } } } | undefined;
        tabs = (st?.tabs ?? []).map((t) => ({ tabId: t.tabId, title: t.title, url: String(t.url).split(/[?#]/)[0] }));
        // The user has one of the thread's tabs and may hand it back (with a note) from here.
        if (st?.session?.handback) yourTurn = st.session.handback.ask ? { ask: String(st.session.handback.ask) } : {};
      }
      const link = current.link && /^https?:\/\//.test(current.link) ? current.link : undefined;
      out.push({ id, title: current.title === id ? "agent-browser" : current.title, link, connected: live.has(id), controlling: tabs.length > 0, tabs, activity, ...(yourTurn ? { yourTurn, canHandBack: !!link } : {}) });
    }
    return { extensionConnected, threads: out };
  }

  /**
   * A second extension connection only replaces the first if the first is dead. Through an SSH
   * tunnel every peer looks like loopback, so a process on the agent machine could otherwise
   * pose as the extension and take over the bridge while Chrome is connected.
   */
  private async acceptExtension(ws: WebSocket): Promise<void> {
    // Hold what the newcomer sends (its hello) until we know whether to accept it, so an
    // impostor cannot answer pending requests and a real extension does not lose its hello.
    const early: Array<[WebSocket.RawData, boolean]> = [];
    const hold = (data: WebSocket.RawData, isBinary: boolean) => early.push([data, isBinary]);
    ws.on("message", hold);
    try {
      await this.checkExtensionSlot(ws);
    } finally {
      ws.off("message", hold);
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    this.onExtension(ws);
    for (const [data, isBinary] of early) ws.emit("message", data, isBinary);
  }

  /** Closes `ws` if the current extension is still alive. */
  private async checkExtensionSlot(ws: WebSocket): Promise<void> {
    const current = this.extension;
    if (current && current !== ws && current.readyState === WebSocket.OPEN) {
      const alive = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_000);
        current.once("pong", () => {
          clearTimeout(timer);
          resolve(true);
        });
        try {
          current.ping();
        } catch {
          clearTimeout(timer);
          resolve(false);
        }
      });
      if (alive) {
        log("refused a second extension connection while the first is alive");
        ws.close(4001, "an extension is already connected");
        return;
      }
    }
  }

  private onExtension(ws: WebSocket): void {
    if (this.extension && this.extension !== ws) {
      log("a newer extension connection replaces the previous one");
      this.extension.close(4000, "replaced");
    }
    this.extension = ws;
    log("extension connected");
    ws.on("message", (raw) => {
      let msg: WireMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "hello") {
        this.extensionInfo = { version: msg.version, userAgent: msg.userAgent };
        log("extension hello", this.extensionInfo);
        const waiters = this.extensionWaiters.splice(0);
        waiters.forEach((w) => w());
        // Releases that could not reach Chrome earlier get another go.
        for (const id of this.activeSessions.keys()) this.scheduleReleaseIfGone(id);
      } else if (msg.type === "response") {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      } else if (msg.type === "event") {
        this.onExtensionEvent(msg);
      } else if (msg.type === "request") {
        void this.onExtensionRequest(msg).then((res) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(res)));
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    });
    ws.on("close", () => {
      if (this.extension === ws) {
        this.extension = null;
        log("extension disconnected");
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve({ type: "response", id, error: { message: "Chrome extension disconnected", code: "no_extension" } });
        }
        this.pending.clear();
        for (const relay of this.relays) relay.onExtensionGone();
      }
    });
  }

  private onExtensionEvent(msg: EventMessage): void {
    for (const relay of this.relays) relay.onEvent(msg);
  }

  /** The extension asks something of the daemon (see EXTENSION_ASKS). */
  private async onExtensionRequest(msg: RequestMessage): Promise<ResponseMessage> {
    const fail = (message: string, code: string): ResponseMessage => ({ type: "response", id: msg.id, error: { message, code } });
    if (msg.method !== "thread.send") return fail(`Unknown request ${msg.method}`, "unknown_method");
    const id = typeof msg.session?.id === "string" ? msg.session.id : "";
    const info = this.activeSessions.get(id) ?? msg.session;
    const message = String(msg.params?.message ?? "").slice(0, 4_000);
    // Only threads the MCP server found in T3 Code have a link; anything else has no thread to post to.
    if (!info?.link) return fail("This agent is not running in a T3 Code thread, so the note cannot be sent there. Tell the agent in its chat.", "not_t3");
    // Never a path from a client or the extension: only T3 Code's own CLI on this machine.
    const cli = localT3Cli();
    if (!cli) return fail("T3 Code's `t3` command was not found on this computer. Tell the agent in its chat.", "no_t3");
    const started = Date.now();
    const r = await sendToThread(cli, id, message);
    this.activity.record(info, "thread.send", {}, r.ok, Date.now() - started);
    if (!r.ok) {
      log("thread.send failed", { session: id, error: r.error });
      return fail(`Could not post to the thread: ${r.error}`, "send_failed");
    }
    return { type: "response", id: msg.id, result: { sent: true } };
  }

  private async waitForExtension(): Promise<boolean> {
    if (this.extension?.readyState === WebSocket.OPEN) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.extensionWaiters = this.extensionWaiters.filter((w) => w !== done);
        resolve(false);
      }, EXTENSION_WAIT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.extensionWaiters.push(done);
    });
  }

  /** Forward one call to the extension. Used by /client connections and by CDP relays. */
  async call(session: SessionInfo, method: string, params?: Record<string, unknown>): Promise<ResponseMessage> {
    if (method !== "session.release" && method !== "extension.reload") {
      this.activeSessions.set(session.id, session);
      // Activity restarts the grace period. With an MCP connection for the thread this is a
      // no-op; relay-only activity (e.g. agent-browser cleaning up as it closes) re-arms it.
      this.cancelRelease(session.id);
      this.scheduleReleaseIfGone(session.id);
    }
    const started = Date.now();
    const res = await this.forward(session, method, params);
    const ms = Date.now() - started;
    // Forget the thread only once Chrome confirmed the release; otherwise it is retried.
    if (method === "session.release" && !res.error) this.activeSessions.delete(session.id);
    this.stats.record(method, ms, !!res.error);
    this.activity.record(session, method, params, !res.error, ms);
    if (res.error) log("call failed", { method, ms, session: session.id, code: res.error.code, error: String(res.error.message ?? "").slice(0, 200) });
    else if (ms > SLOW_CALL_MS) log("slow call", { method, ms });
    else if (process.env.T3_BROWSER_DEBUG) log("call", { method, ms });
    return res;
  }

  private async forward(session: SessionInfo, method: string, params?: Record<string, unknown>): Promise<ResponseMessage> {
    if (!(await this.waitForExtension())) {
      return {
        type: "response",
        id: 0,
        error: {
          code: "no_extension",
          message:
            "The T3 Browser Chrome extension is not connected. Ask the user to open Chrome and make sure the " +
            "extension is installed and enabled (run `t3-browser doctor` for setup steps).",
        },
      };
    }
    const id = this.nextId++;
    const msg: RequestMessage = { type: "request", id, session, method, params };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The extension bounds its own waits well below this, so reaching it means Chrome
        // itself stopped answering (or an old extension build is still loaded).
        resolve({ type: "response", id, error: { message: `Timed out waiting for Chrome (${method})`, code: "timeout" } });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.extension!.send(JSON.stringify(msg));
    });
  }

  private onClient(ws: WebSocket): void {
    this.clients.add(ws);
    this.bumpIdle();
    ws.on("message", async (raw) => {
      let msg: WireMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type !== "request" || typeof msg.session?.id !== "string") return;
      if (msg.method === "page.upload" && Array.isArray(msg.params?.inlineFiles)) {
        // A remote agent sent file contents: put them on this machine, where Chrome can read them.
        try {
          const { inlineFiles, ...rest } = msg.params as { inlineFiles: InlineFile[] };
          msg.params = { ...rest, files: materializeUploads(inlineFiles) };
        } catch (err) {
          ws.send(JSON.stringify({ type: "response", id: msg.id, error: { message: String((err as Error).message ?? err), code: "upload_failed" } } satisfies ResponseMessage));
          return;
        }
      }
      this.connectionSession.set(ws, msg.session.id);
      this.cancelRelease(msg.session.id);
      if (msg.method === "daemon.status") {
        ws.send(
          JSON.stringify({
            type: "response",
            id: msg.id,
            result: {
              version: VERSION,
              port: this.port,
              extensionConnected: this.extension?.readyState === WebSocket.OPEN,
              extension: this.extensionInfo,
              cdpUrl: `ws://127.0.0.1:${this.port}/cdp/${encodeURIComponent(msg.session.id)}?token=${this.token}`,
              stats: this.stats.summary(),
            },
          } satisfies ResponseMessage),
        );
        return;
      }
      const res = await this.call(msg.session, msg.method, msg.params);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...res, id: msg.id }));
    });
    ws.on("close", () => {
      this.clients.delete(ws);
      this.connectionGone(ws);
      this.bumpIdle();
    });
  }

  private onCdp(ws: WebSocket, sessionId: string): void {
    const relay = new CdpRelay(ws, { id: sessionId, title: sessionId }, this, log);
    this.relays.add(relay);
    this.bumpIdle();
    ws.on("close", () => {
      this.relays.delete(relay);
      relay.dispose();
      this.bumpIdle();
    });
  }

  // ---- Releasing a thread's tabs when the thread is gone ------------------------------------
  // The MCP server exits when its agent session ends (or T3 Code restarts it). If nothing for
  // that thread reconnects for a while, the agent is not coming back for its tabs: detach the
  // debugger and overlay and leave the tabs in a collapsed group for the user.

  private connectionGone(conn: WebSocket): void {
    const id = this.connectionSession.get(conn);
    this.connectionSession.delete(conn);
    if (id) this.scheduleReleaseIfGone(id);
  }

  private scheduleReleaseIfGone(id: string): void {
    if (!this.activeSessions.has(id) || this.releaseTimers.has(id) || [...this.connectionSession.values()].includes(id)) return;
    const timer = setTimeout(() => void this.releaseGone(id).catch((e) => log("release failed", String(e))), RELEASE_AFTER_MS);
    timer.unref();
    this.releaseTimers.set(id, timer);
  }

  private cancelRelease(id: string): void {
    const t = this.releaseTimers.get(id);
    if (t) clearTimeout(t);
    this.releaseTimers.delete(id);
  }

  private async releaseGone(id: string): Promise<void> {
    this.releaseTimers.delete(id);
    const session = this.activeSessions.get(id);
    if (!session || [...this.connectionSession.values()].includes(id)) return;
    if (this.extension?.readyState !== WebSocket.OPEN) return; // retried when Chrome says hello
    const res = await this.call(session, "session.release", { closeTabs: false, keepGroup: true });
    log("released the tabs of a thread that went away", { session: id, result: res.result, error: res.error?.message });
  }

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // A remote agent cannot start a daemon on this machine, so never quit when it may need one.
    if (this.clients.size || this.relays.size || this.remoteConfigured) return;
    this.idleTimer = setTimeout(() => {
      log("no clients for a while, exiting");
      process.exit(0);
    }, IDLE_EXIT_MS);
    this.idleTimer.unref();
  }
}

export async function runDaemon(): Promise<void> {
  // Last line of defence: a bug in one request handler must not take every agent's browser down.
  process.on("unhandledRejection", (err) => log("unhandled rejection", String((err as Error)?.stack ?? err)));
  process.on("uncaughtException", (err) => log("uncaught exception", String(err?.stack ?? err)));
  const daemon = new Daemon();
  try {
    await daemon.start();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      log("port in use; another daemon is probably running");
      process.exit(0);
    }
    throw err;
  }
}

/** The path of a request URL, or undefined for one that does not parse (e.g. "//"). */
function parsePath(url: string | undefined): string | undefined {
  try {
    return new URL(url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return undefined;
  }
}

/** A small JSON request body (control page actions); anything large or malformed is {}. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
    req.on("close", () => resolve({}));
  });
}
