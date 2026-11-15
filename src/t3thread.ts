// What T3 Code knows about the thread this MCP server serves: its real title (for the tab
// group name) and whether it has ended (settled or archived), read through T3 Code's own CLI
// (`t3 thread show <id> --json`). Everything here is best effort: outside T3 Code, or when the
// CLI is slow or missing, callers fall back to the environment.

import { spawn } from "node:child_process";

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

export function readThread(cliPath: string, threadId: string, timeoutMs = 4_000): Promise<ThreadInfo | undefined> {
  if (!cliPath || !SAFE_ID.test(threadId)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    // The Windows launcher is a .cmd file, which Node only runs through a shell.
    const isCmd = /\.(cmd|bat)$/i.test(cliPath);
    const opts = { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
    const child = isCmd
      ? spawn(`"${cliPath}" thread show ${threadId} --json --messages 0`, { ...opts, shell: true })
      : spawn(cliPath, ["thread", "show", threadId, "--json", "--messages", "0"], opts);
    let out = "";
    const done = (info: ThreadInfo | undefined) => {
      clearTimeout(timer);
      resolve(info);
    };
    const timer = setTimeout(() => {
      // Through a shell, kill() would only end cmd.exe and leave the CLI it started running.
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
      else child.kill();
      done(undefined);
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", () => done(undefined));
    child.on("close", (code) => done(code === 0 ? parseThreadJson(out) : undefined));
  });
}
