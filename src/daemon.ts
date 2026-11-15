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
import { writeFileSync, appendFileSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { CdpRelay } from "./cdp-relay.js";
import { DAEMON_FILE, LOG_FILE, PORT, ensureHome, readOrCreateToken } from "./paths.js";
import {
  EXTENSION_ID,
  PROTOCOL_VERSION,
  type EventMessage,
  type RequestMessage,
  type ResponseMessage,
  type SessionInfo,
  type WireMessage,
} from "./protocol.js";
import { VERSION } from "./version.js";

const EXTENSION_WAIT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 120_000;
const IDLE_EXIT_MS = 30 * 60_000;

function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  try {
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
  return presented === token;
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
  private idleTimer: NodeJS.Timeout | null = null;
  readonly token = readOrCreateToken();

  constructor(private readonly port = PORT) {}

  start(): Promise<void> {
    ensureHome();
    const http = createServer((req, res) => this.onHttp(req, res));
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

    http.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/extension") {
        if (!allowedExtensionOrigins().has(req.headers.origin ?? "")) {
          log("rejected extension connection from origin", req.headers.origin ?? "(none)");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.onExtension(ws));
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
    });

    return new Promise((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.port, "127.0.0.1", () => {
        writeFileSync(DAEMON_FILE, JSON.stringify({ pid: process.pid, port: this.port, version: VERSION }, null, 2));
        log(`daemon ${VERSION} listening on 127.0.0.1:${this.port}`);
        this.bumpIdle();
        resolve();
      });
    });
  }

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
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
          webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/cdp/${m[1]}?token=${this.token}`,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
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
      if (msg.type === "hello") {
        this.extensionInfo = { version: msg.version, userAgent: msg.userAgent };
        log("extension hello", this.extensionInfo);
        const waiters = this.extensionWaiters.splice(0);
        waiters.forEach((w) => w());
      } else if (msg.type === "response") {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      } else if (msg.type === "event") {
        this.onExtensionEvent(msg);
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
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type !== "request") return;
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

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.clients.size || this.relays.size) return;
    this.idleTimer = setTimeout(() => {
      log("no clients for a while, exiting");
      process.exit(0);
    }, IDLE_EXIT_MS);
    this.idleTimer.unref();
  }
}

export async function runDaemon(): Promise<void> {
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
