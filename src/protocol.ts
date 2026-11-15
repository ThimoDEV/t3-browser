// Wire protocol shared by the daemon, the MCP server and the Chrome extension.
// Everything is JSON over a single localhost WebSocket port.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47823;
/** Stable ID derived from the public key pinned in extension/manifest.json. */
export const EXTENSION_ID = "doaacelnfjdbbfhhkglnkdgboeajnlhk";

/** One agent thread. Each session gets its own Chrome tab group. */
export interface SessionInfo {
  id: string;
  title: string;
  /** Link to the thread in T3 Code, when known (shown in the popup and on the page pill). */
  link?: string;
}

export interface TabInfo {
  /** Chrome tab id. */
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  /** "loading" | "complete" */
  status?: string;
  /** True when the tab sits in this session's tab group. */
  inSession: boolean;
  windowId?: number;
}

export interface RpcError {
  message: string;
  /** Machine-readable reason, e.g. "interrupted", "restricted", "not_owned", "no_extension". */
  code?: string;
}

/** Sent by the daemon to the extension, and by clients to the daemon. */
export interface RequestMessage {
  type: "request";
  id: number;
  session: SessionInfo;
  method: string;
  params?: Record<string, unknown>;
}

export interface ResponseMessage {
  type: "response";
  id: number;
  result?: unknown;
  error?: RpcError;
}

/** Unsolicited extension -> daemon notifications (CDP events for the relay, interrupts). */
export interface EventMessage {
  type: "event";
  sessionId?: string;
  event: string;
  data?: unknown;
}

export interface HelloMessage {
  type: "hello";
  role: "extension" | "client";
  protocol: number;
  version?: string;
  userAgent?: string;
}

export interface PingMessage {
  type: "ping" | "pong";
}

export type WireMessage = RequestMessage | ResponseMessage | EventMessage | HelloMessage | PingMessage;

/** Methods the extension implements. Params are documented in extension/src/commands.ts. */
export const EXTENSION_METHODS = [
  "status",
  "tabs.list",
  "tabs.open",
  "tabs.claim",
  "tabs.close",
  "tabs.navigate",
  "page.snapshot",
  "page.click",
  "page.type",
  "page.press",
  "page.scroll",
  "page.select",
  "page.hover",
  "page.screenshot",
  "page.read",
  "page.eval",
  "page.wait",
  "page.upload",
  "page.dialog",
  "session.name",
  "session.release",
  "cdp.attach",
  "cdp.detach",
  "cdp.send",
  "extension.reload",
  "session.stop",
  "page.peek",
] as const;

export type ExtensionMethod = (typeof EXTENSION_METHODS)[number];
