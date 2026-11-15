import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "./protocol.js";

export const HOME = process.env.T3_BROWSER_HOME ?? join(homedir(), ".t3-browser");
export const TOKEN_FILE = join(HOME, "token");
export const DAEMON_FILE = join(HOME, "daemon.json");
export const LOG_FILE = join(HOME, "daemon.log");
/** On an agent machine: which remote daemon to use (written by `t3-browser remote-link`). */
export const REMOTE_FILE = join(HOME, "remote.json");
/** On the Chrome machine: extra addresses the daemon listens on (written by `t3-browser remote --listen`). */
export const CONFIG_FILE = join(HOME, "config.json");

export const PORT = Number(process.env.T3_BROWSER_PORT ?? DEFAULT_PORT);

/** Repo/package root (dist/cli.js lives one level below it). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_PATH = join(PACKAGE_ROOT, "dist", "cli.js");
export const EXTENSION_DIR = join(PACKAGE_ROOT, "extension", "dist");
export const SKILL_DIR = join(PACKAGE_ROOT, "skills", "t3-browser");

export function ensureHome(): void {
  mkdirSync(HOME, { recursive: true });
}

/**
 * Shared secret for local clients (the MCP server, agent-browser via the CDP relay).
 * The extension does not use it: it is authenticated by its chrome-extension:// Origin,
 * which web pages cannot forge.
 */
export function readOrCreateToken(): string {
  ensureHome();
  if (existsSync(TOKEN_FILE)) {
    const token = readFileSync(TOKEN_FILE, "utf8").trim();
    if (token.length >= 32) return token;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}
