// Registers the MCP server with the agent CLIs T3 Code runs (Claude Code, Codex, Cursor) and
// installs the skill. T3 Code launches those CLIs, so they pick the tools up automatically.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLI_PATH, EXTENSION_DIR, SKILL_DIR } from "./paths.js";
import { EXTENSION_ID } from "./protocol.js";

const NAME = "t3-browser";
const home = homedir();

type Target = "claude" | "codex" | "cursor";

function has(cmd: string): boolean {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  return r.status === 0;
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Quote for a shell command line (spawnSync with shell:true on Windows). */
const q = (s: string) => (process.platform === "win32" ? `"${s}"` : s);

function serverCommand(): { command: string; args: string[] } {
  return { command: process.execPath, args: [CLI_PATH, "mcp"] };
}

function installClaude(): string {
  if (!has("claude")) return "Claude Code: `claude` not found on PATH, skipped";
  run("claude", ["mcp", "remove", "--scope", "user", NAME]);
  const { command, args } = serverCommand();
  const r = run("claude", ["mcp", "add", "--scope", "user", NAME, "--", q(command), ...args.map(q)]);
  const skillDest = join(home, ".claude", "skills", NAME);
  mkdirSync(dirname(skillDest), { recursive: true });
  cpSync(SKILL_DIR, skillDest, { recursive: true });
  return r.ok ? `Claude Code: registered MCP server (user scope) and skill at ${skillDest}` : `Claude Code: failed: ${r.out}`;
}

function installCodex(): string {
  if (!has("codex")) return "Codex: `codex` not found on PATH, skipped";
  run("codex", ["mcp", "remove", NAME]);
  const { command, args } = serverCommand();
  const r = run("codex", ["mcp", "add", NAME, "--", q(command), ...args.map(q)]);
  const skillDest = join(home, ".codex", "skills", NAME);
  mkdirSync(dirname(skillDest), { recursive: true });
  cpSync(SKILL_DIR, skillDest, { recursive: true });
  return r.ok ? `Codex: registered MCP server and skill at ${skillDest}` : `Codex: failed: ${r.out}`;
}

function cursorConfigPath(): string {
  return join(home, ".cursor", "mcp.json");
}

function installCursor(): string {
  const file = cursorConfigPath();
  if (!existsSync(dirname(file))) return "Cursor: ~/.cursor not found, skipped";
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8") || "{}") : {};
  cfg.mcpServers ??= {};
  cfg.mcpServers[NAME] = serverCommand();
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return `Cursor: registered MCP server in ${file}`;
}

export function install(targets: Target[]): string[] {
  if (!existsSync(CLI_PATH)) throw new Error(`Build first: ${CLI_PATH} is missing (run \`npm run build\`).`);
  const out: string[] = [];
  for (const t of targets) {
    try {
      out.push(t === "claude" ? installClaude() : t === "codex" ? installCodex() : installCursor());
    } catch (e) {
      out.push(`${t}: failed: ${(e as Error).message}`);
    }
  }
  return out;
}

export function uninstall(): string[] {
  const out: string[] = [];
  if (has("claude")) {
    run("claude", ["mcp", "remove", "--scope", "user", NAME]);
    rmSync(join(home, ".claude", "skills", NAME), { recursive: true, force: true });
    out.push("Claude Code: removed");
  }
  if (has("codex")) {
    run("codex", ["mcp", "remove", NAME]);
    rmSync(join(home, ".codex", "skills", NAME), { recursive: true, force: true });
    out.push("Codex: removed");
  }
  const file = cursorConfigPath();
  if (existsSync(file)) {
    const cfg = JSON.parse(readFileSync(file, "utf8") || "{}");
    if (cfg.mcpServers?.[NAME]) {
      delete cfg.mcpServers[NAME];
      writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
      out.push("Cursor: removed");
    }
  }
  out.push("Remove the T3 Browser extension from chrome://extensions to finish.");
  return out;
}

export function extensionSteps(): string {
  return [
    "Load the Chrome extension (one time):",
    "  1. Open chrome://extensions and turn on Developer mode (top right).",
    `  2. Click "Load unpacked" and pick: ${EXTENSION_DIR}`,
    `  3. Check that the ID is ${EXTENSION_ID}. Pin "T3 Browser" to the toolbar to see its status.`,
    "Then start a new thread in T3 Code and ask it to do something in your browser.",
  ].join("\n");
}

export function openExtensionsPage(): void {
  try {
    if (process.platform === "win32") execFileSync("explorer.exe", [EXTENSION_DIR]);
    else if (process.platform === "darwin") execFileSync("open", [EXTENSION_DIR]);
  } catch {
    // explorer.exe returns 1 even on success; opening a folder is best-effort anyway
  }
}
