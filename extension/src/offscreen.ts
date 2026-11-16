// Offscreen document: owns the WebSocket to the local daemon and relays messages to the
// service worker. Offscreen documents are not suspended, so the bridge reconnects within
// a couple of seconds whenever T3 Code (re)starts the daemon.

import { PROTOCOL_VERSION, type RequestMessage, type ResponseMessage, type WireMessage } from "../../src/protocol";

const params = new URLSearchParams(location.search);
const port = Number(params.get("port") ?? 47823);
// Offscreen documents only get chrome.runtime messaging: no getManifest(). The service worker
// passes the version in the URL. (Calling getManifest() here threw inside onopen, so the hello,
// the "connected" badge report and the keep-alive pings never happened.)
const version = params.get("version") ?? "";
let ws: WebSocket | null = null;
let retryMs = 1000;
let pingTimer: number | undefined;
/** The extension's own requests to the daemon (EXTENSION_ASKS), by id, until it answers. */
const asks = new Map<number, (res: ResponseMessage) => void>();
let nextAsk = 1;
const ASK_TIMEOUT_MS = 30_000;

function failAsks(message: string): void {
  for (const [id, done] of asks) done({ type: "response", id, error: { message, code: "no_daemon" } });
  asks.clear();
}

function report(connected: boolean): void {
  chrome.runtime.sendMessage({ kind: "transport", connected }).catch(() => {});
}

function connect(): void {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  ws = socket;

  socket.onopen = () => {
    retryMs = 1000;
    socket.send(
      JSON.stringify({
        type: "hello",
        role: "extension",
        protocol: PROTOCOL_VERSION,
        version,
        userAgent: navigator.userAgent,
      } satisfies WireMessage),
    );
    report(true);
    clearInterval(pingTimer);
    pingTimer = window.setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('{"type":"ping"}'), 20_000);
  };

  socket.onmessage = async (ev) => {
    let msg: WireMessage;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === "response") {
      asks.get(msg.id)?.(msg);
      asks.delete(msg.id);
      return;
    }
    if (msg.type !== "request") return;
    const response = await chrome.runtime.sendMessage({ kind: "rpc", msg: msg as RequestMessage }).catch((err: unknown) => ({
      type: "response",
      id: msg.type === "request" ? msg.id : 0,
      error: { message: `Extension error: ${String((err as Error)?.message ?? err)}` },
    }));
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
  };

  socket.onclose = () => {
    clearInterval(pingTimer);
    failAsks("Lost the connection to T3 Browser. Tell the agent in its chat.");
    if (ws === socket) ws = null;
    report(false);
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 1.5, 5000);
  };
  socket.onerror = () => socket.close();
}

// Service worker -> daemon events (CDP events for the relay, interrupts, tab changes).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind === "event" && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message.msg));
  if (message?.kind === "transport-query") sendResponse(ws?.readyState === WebSocket.OPEN);
  if (message?.kind === "ask") {
    const socket = ws;
    if (socket?.readyState !== WebSocket.OPEN) {
      sendResponse({ type: "response", id: 0, error: { message: "T3 Browser is not connected to T3 Code right now. Tell the agent in its chat.", code: "no_daemon" } });
      return false;
    }
    const id = nextAsk++;
    const timer = setTimeout(() => asks.get(id)?.({ type: "response", id, error: { message: "T3 Code did not answer in time.", code: "timeout" } }), ASK_TIMEOUT_MS);
    asks.set(id, (res) => {
      clearTimeout(timer);
      asks.delete(id);
      sendResponse(res);
    });
    socket.send(JSON.stringify({ ...(message.msg as RequestMessage), id }));
    return true;
  }
  return false;
});

connect();
