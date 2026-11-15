// Connection from one agent thread (the MCP server process) to the shared daemon.
// Starts the daemon on demand, the same way agent-browser starts its own.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { WebSocket } from "ws";
import { CLI_PATH, LOG_FILE, PORT, ensureHome, readOrCreateToken } from "./paths.js";
import type { RequestMessage, ResponseMessage, SessionInfo } from "./protocol.js";

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { name?: string };
    return body.name === "t3-browser";
  } catch {
    return false;
  }
}

export async function ensureDaemon(port = PORT): Promise<void> {
  if (await healthy(port)) return;
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
    if (await healthy(port)) return;
  }
  throw new BridgeError(`Could not start the t3-browser daemon on port ${port}. See ${LOG_FILE}.`, "no_daemon");
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextId = 1;
  private pending = new Map<number, (msg: ResponseMessage) => void>();

  constructor(
    readonly session: SessionInfo,
    private readonly port = PORT,
  ) {}

  private connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await ensureDaemon(this.port);
      const token = readOrCreateToken();
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/client`, {
        headers: { authorization: `Bearer ${token}` },
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
