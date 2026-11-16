// Talking to T3 Code through its own CLI. Reads what T3 Code knows about a thread: its real
// title (for the tab group name), its link, and whether it has ended (settled or archived), with
// `t3 thread show <id> --json`. Posts the user's hand-back note to it with `t3 thread send`.
// Reading is best effort: outside T3 Code, or when the CLI is slow or missing, callers fall
// back to the environment.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ThreadInfo {
  title?: string;
  /** The thread in T3 Code (web link). */
  link?: string;
  /** The user settled or archived the thread: its agent is done with the browser. */
  ended: boolean;
}

export function parseThreadJson(text: string): ThreadInfo | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  const thread = (data as { thread?: Record<string, unknown> })?.thread;
  if (!thread || typeof thread !== "object") return undefined;
  const title = typeof thread.title === "string" && thread.title.trim() ? thread.title.trim() : undefined;
  // A thread with a run in progress is still using the browser, whatever its flags say.
  const running = !!thread.activeRunId;
  const link = typeof thread.link === "string" && /^https?:\/\//.test(thread.link) ? thread.link : undefined;
  return { title, ...(link ? { link } : {}), ended: !running && (thread.archived === true || thread.settled === true) };
}

/** Thread ids come from T3 Code's environment; anything else is not passed to a shell. */
const SAFE_ID = /^[\w:.-]{1,200}$/;

/** T3 Code's own `t3` command on this machine: the one T3 Code points agents at, else its usual home. */
export function localT3Cli(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.T3CODE_CLI_PATH) return env.T3CODE_CLI_PATH;
  const path = join(homedir(), ".t3", "bin", process.platform === "win32" ? "t3.cmd" : "t3");
  return existsSync(path) ? path : undefined;
}

interface Run {
  code: number | null;
  out: string;
  err: string;
}

/**
 * Run `t3 <args>`, feeding `stdin` if given. Arguments must be shell-safe (the Windows launcher
 * is a .cmd file, which Node only runs through a shell); free text goes through stdin.
 */
function runT3(cliPath: string, args: string[], timeoutMs: number, stdin?: string): Promise<Run | undefined> {
  return new Promise((resolve) => {
    const isCmd = /\.(cmd|bat)$/i.test(cliPath);
    const opts = { windowsHide: true, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
    const child = isCmd ? spawn(`"${cliPath}" ${args.join(" ")}`, { ...opts, shell: true }) : spawn(cliPath, args, opts);
    let out = "";
    let err = "";
    const done = (r: Run | undefined) => {
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      // Through a shell, kill() would only end cmd.exe and leave the CLI it started running.
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
      else child.kill();
      done(undefined);
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
    child.on("error", () => done(undefined));
    child.on("close", (code) => done({ code, out, err }));
  });
}

export async function readThread(cliPath: string, threadId: string, timeoutMs = 4_000): Promise<ThreadInfo | undefined> {
  if (!cliPath || !SAFE_ID.test(threadId)) return undefined;
  const r = await runT3(cliPath, ["thread", "show", threadId, "--json", "--messages", "0"], timeoutMs);
  return r?.code === 0 ? parseThreadJson(r.out) : undefined;
}

/**
 * Post `message` to the thread as the user (`t3 thread send <id> -`): a busy thread gets it as
 * its next turn, an idle one starts working on it. The text goes through stdin, never a shell.
 */
export async function sendToThread(cliPath: string, threadId: string, message: string, timeoutMs = 15_000): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!SAFE_ID.test(threadId)) return { ok: false, error: "That thread id cannot be used." };
  const r = await runT3(cliPath, ["thread", "send", threadId, "-"], timeoutMs, message);
  if (!r) return { ok: false, error: "T3 Code did not answer in time." };
  if (r.code !== 0) return { ok: false, error: (r.err || r.out).trim().split("\n").pop()?.slice(0, 300) || `t3 exited with code ${r.code}.` };
  return { ok: true };
}
