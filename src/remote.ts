// Remote use: an agent on another machine (a VPS, a linked T3 Code environment) drives the
// Chrome on the user's desk. The machine with Chrome runs the daemon and may additionally
// listen on a private address (Tailscale, LAN) or be reached through an SSH tunnel; the agent
// machine is "linked" to it with the daemon's URL and token.
//
//   agent machine:  MCP server ──ws + token──▶  daemon on the Chrome machine ──▶ extension
//
// The extension endpoint stays loopback-only: Chrome always runs next to its daemon.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { basename, join } from "node:path";
import { CONFIG_FILE, HOME, PORT, REMOTE_FILE, ensureHome, readOrCreateToken } from "./paths.js";

export interface Endpoint {
  /** http(s)://host:port of the daemon. */
  base: string;
  token: string;
  /** The daemon runs on another machine: never start one here, ship upload contents. */
  remote: boolean;
}

/** Accepts ws://, wss://, http:// or https:// and returns http(s)://host[:port]. */
export function normalizeBase(url: string): string {
  const u = new URL(url.trim());
  if (!/^(wss?|https?):$/.test(u.protocol)) throw new Error(`Unsupported URL ${url}: use ws://host:port or http://host:port`);
  const secure = u.protocol === "wss:" || u.protocol === "https:";
  return `${secure ? "https" : "http"}://${u.host}`;
}

export function wsBase(base: string): string {
  return base.replace(/^http/, "ws");
}

interface RemoteLink {
  url: string;
  token: string;
}

export function readRemoteLink(): RemoteLink | undefined {
  try {
    const v = JSON.parse(readFileSync(REMOTE_FILE, "utf8")) as Partial<RemoteLink>;
    if (typeof v.url === "string" && typeof v.token === "string" && v.token.length >= 32) return { url: normalizeBase(v.url), token: v.token };
  } catch {
    // no link, or a broken file: use the local daemon
  }
  return undefined;
}

export function writeRemoteLink(url: string, token: string): void {
  ensureHome();
  writeFileSync(REMOTE_FILE, JSON.stringify({ url: normalizeBase(url), token }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(REMOTE_FILE, 0o600); // mode above only applies when the file is created
}

export function removeRemoteLink(): boolean {
  if (!existsSync(REMOTE_FILE)) return false;
  rmSync(REMOTE_FILE);
  return true;
}

/** Which daemon this process talks to: T3_BROWSER_URL/TOKEN, then a saved link, then the local one. */
export function bridgeEndpoint(): Endpoint {
  const url = process.env.T3_BROWSER_URL;
  // Never send this machine's own token to another host: without T3_BROWSER_TOKEN the client refuses.
  if (url) return { base: normalizeBase(url), token: process.env.T3_BROWSER_TOKEN ?? "", remote: true };
  const link = readRemoteLink();
  if (link) return { base: link.url, token: link.token, remote: true };
  return { base: `http://127.0.0.1:${PORT}`, token: readOrCreateToken(), remote: false };
}

// ---- Where the daemon listens -------------------------------------------------------------------

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, "");
  return a === "::1" || /^127\./.test(a);
}

/**
 * Extra addresses must be specific private ones: loopback, RFC 1918 LAN, Tailscale/CGNAT
 * (100.64.0.0/10) or IPv6 unique-local. Wildcards and public addresses would put the browser
 * one leaked token away from the internet. Returns an error message, or undefined when fine.
 */
export function checkListenAddress(addr: string): string | undefined {
  const a = addr.trim().replace(/^\[|\]$/g, "");
  const v = isIP(a);
  if (!v) return `${addr} is not an IP address (use the machine's Tailscale or LAN IP)`;
  if (a === "0.0.0.0" || a === "::") return `${addr} would listen on every interface; pick one private address`;
  if (v === 4) {
    const [p, q] = a.split(".").map(Number);
    const ok = p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127);
    return ok ? undefined : `${addr} is a public address; use Tailscale (100.x), a LAN address or an SSH tunnel`;
  }
  const lower = a.toLowerCase();
  return lower === "::1" || /^f[cd][0-9a-f]{2}:/.test(lower) ? undefined : `${addr} is not a private IPv6 address`;
}

interface DaemonConfig {
  listen: string[];
}

export function readDaemonConfig(): DaemonConfig {
  const fromEnv = process.env.T3_BROWSER_LISTEN;
  if (fromEnv !== undefined) return { listen: fromEnv.split(",").map((x) => x.trim()).filter(Boolean) };
  try {
    const v = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<DaemonConfig>;
    return { listen: Array.isArray(v.listen) ? v.listen.map((x) => String(x).trim()).filter(Boolean) : [] };
  } catch {
    return { listen: [] };
  }
}

export function writeDaemonConfig(config: DaemonConfig): void {
  ensureHome();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

// ---- Uploads from another machine ----------------------------------------------------------------
// File paths an agent passes refer to its own machine. A remote MCP server sends the contents
// instead; the daemon writes them to a private folder here and hands Chrome those paths.

export interface InlineFile {
  name: string;
  /** base64 */
  data: string;
}

export const MAX_INLINE_UPLOAD_BYTES = 40 * 1024 * 1024;
const UPLOAD_TTL_MS = 10 * 60_000;

export function materializeUploads(files: InlineFile[]): string[] {
  const total = files.reduce((n, f) => n + Math.floor((f.data?.length ?? 0) * 0.75), 0);
  if (total > MAX_INLINE_UPLOAD_BYTES) throw new Error(`Uploads from another machine are limited to ${MAX_INLINE_UPLOAD_BYTES / 1024 / 1024}MB in total`);
  const dir = join(HOME, "uploads", randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Cleaned up later even if a write below fails; the daemon also clears the folder on start.
  setTimeout(() => rmSync(dir, { recursive: true, force: true }), UPLOAD_TTL_MS).unref();
  return files.map((f, i) => {
    // Keep the file name the site will see, but never a path: no traversal out of the folder.
    // One sub-folder per file, so two files with the same name do not overwrite each other.
    const name = basename(String(f.name || `file-${i + 1}`)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || `file-${i + 1}`;
    const sub = join(dir, String(i));
    mkdirSync(sub);
    const p = join(sub, name === "." || name === ".." ? `file-${i + 1}` : name);
    writeFileSync(p, Buffer.from(String(f.data), "base64"));
    return p;
  });
}
