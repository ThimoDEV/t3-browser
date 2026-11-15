// Connection from one agent thread (the MCP server process) to the shared daemon.
// Starts the local daemon on demand, the same way agent-browser starts its own; when this
// machine is linked to the daemon on another machine (see remote.ts), it talks to that one.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { WebSocket } from "ws";
import { CLI_PATH, LOG_FILE, ensureHome } from "./paths.js";
import type { RequestMessage, ResponseMessage, SessionInfo } from "./protocol.js";
import { bridgeEndpoint, wsBase, type Endpoint } from "./remote.js";

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function healthy(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { name?: string };
    return body.name === "t3-browser";
  } catch {
    return false;
  }
}

/** True when the daemon this process would use answers; never starts one. */
export function isDaemonRunning(endpoint: Endpoint = bridgeEndpoint()): Promise<boolean> {
  return healthy(endpoint.base);
}

export async function ensureDaemon(endpoint: Endpoint = bridgeEndpoint()): Promise<void> {
  if (await healthy(endpoint.base)) return;
  if (endpoint.remote) {
    throw new BridgeError(
      `Cannot reach the T3 Browser daemon at ${endpoint.base} (this machine is linked to the Chrome on another machine). ` +
        "Ask the user to check that machine is on and reachable (Tailscale up, or the SSH tunnel open).",
      "no_daemon",
    );
  }
  ensureHome();
  const out = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [CLI_PATH, "daemon"], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await healthy(endpoint.base)) return;
  }
  throw new BridgeError(`Could not start the t3-browser daemon at ${endpoint.base}. See ${LOG_FILE}.`, "no_daemon");
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextId = 1;
  private pending = new Map<number, (msg: ResponseMessage) => void>();

  constructor(
    readonly session: SessionInfo,
    readonly endpoint: Endpoint = bridgeEndpoint(),
  ) {}

  /** The daemon (and so Chrome) is on another machine. */
  get remote(): boolean {
    return this.endpoint.remote;
  }

  /** Rewrite a daemon-made ws://127.0.0.1:port/... URL to how this machine reaches the daemon. */
  reachable(url: string): string {
    const u = new URL(url);
    const b = new URL(wsBase(this.endpoint.base));
    u.protocol = b.protocol;
    u.hostname = b.hostname;
    u.port = b.port; // "" for the scheme's default port
    return u.toString();
  }

  private connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (this.endpoint.remote && !this.endpoint.token) {
        throw new BridgeError("T3_BROWSER_URL is set but T3_BROWSER_TOKEN is not. Run `t3-browser remote` on the machine with Chrome for both.", "no_token");
      }
      await ensureDaemon(this.endpoint);
      const ws = new WebSocket(`${wsBase(this.endpoint.base)}/client`, {
        headers: { authorization: `Bearer ${this.endpoint.token}` },
        maxPayload: 64 * 1024 * 1024,
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as ResponseMessage;
        if (msg.type !== "response") return;
        const cb = this.pending.get(msg.id);
        if (cb) {
          this.pending.delete(msg.id);
          cb(msg);
        }
      });
      ws.on("close", () => {
        if (this.ws === ws) this.ws = null;
        for (const [id, cb] of this.pending) {
          cb({ type: "response", id, error: { message: "Lost connection to the t3-browser daemon", code: "no_daemon" } });
        }
        this.pending.clear();
      });
      this.ws = ws;
      return ws;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const ws = await this.connect();
    const id = this.nextId++;
    const msg: RequestMessage = { type: "request", id, session: this.session, method, params };
    const res = await new Promise<ResponseMessage>((resolve) => {
      this.pending.set(id, resolve);
      ws.send(JSON.stringify(msg));
    });
    if (res.error) throw new BridgeError(res.error.message, res.error.code);
    return res.result as T;
  }

  close(): void {
    this.ws?.close();
  }
}
