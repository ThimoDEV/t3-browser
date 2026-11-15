// Tab groups are named after the real T3 Code thread, and a settled or archived thread
// releases its tabs. Both come from `t3 thread show <id> --json`.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseThreadJson, readThread } from "../../src/t3thread";

describe("parseThreadJson", () => {
  it("reads the title of a live thread", () => {
    expect(parseThreadJson(JSON.stringify({ thread: { title: "  Fix login flow ", archived: false, settled: false }, messages: [] }))).toEqual({
      title: "Fix login flow",
      ended: false,
    });
  });

  it.each([{ settled: true }, { archived: true }])("treats %o as ended", (flags) => {
    expect(parseThreadJson(JSON.stringify({ thread: { title: "x", ...flags } }))?.ended).toBe(true);
  });

  it("never treats a thread with a run in progress as ended", () => {
    expect(parseThreadJson(JSON.stringify({ thread: { title: "x", settled: true, activeRunId: "run:1" } }))?.ended).toBe(false);
  });

  it("returns nothing usable for junk or an untitled thread", () => {
    expect(parseThreadJson("Thread x is no longer available.")).toBeUndefined();
    expect(parseThreadJson(JSON.stringify({ nope: 1 }))).toBeUndefined();
    expect(parseThreadJson(JSON.stringify({ thread: { title: "" } }))).toEqual({ title: undefined, ended: false });
  });
});

/**
 * A stand-in for T3 Code's CLI running `body` (a Node script with `args` in scope). On Windows
 * it is a .cmd launcher, like the real `t3.cmd`.
 */
function fakeCli(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "t3b-cli-"));
  const script = join(dir, "fake.mjs");
  writeFileSync(script, `const args = process.argv.slice(2);\n${body}`);
  if (process.platform === "win32") {
    const cmd = join(dir, "t3.cmd");
    writeFileSync(cmd, `@"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const sh = join(dir, "t3");
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe("readThread", () => {
  it("runs `t3 thread show <id> --json` and reads the title", async () => {
    const cli = fakeCli(
      `const ok = args[0] === "thread" && args[1] === "show" && args[2] === "mcp:abc-123" && args.includes("--json");
       process.stdout.write(ok ? JSON.stringify({ thread: { title: "Book dentist", settled: false } }) : "bad args " + args.join(" "));`,
    );
    expect(await readThread(cli, "mcp:abc-123")).toEqual({ title: "Book dentist", ended: false });
  });

  it("reports nothing when the CLI fails", async () => {
    const cli = fakeCli(`process.stdout.write("Thread is no longer available."); process.exit(1);`);
    expect(await readThread(cli, "abc")).toBeUndefined();
  });

  it("never passes an unexpected thread id to a shell", async () => {
    const cli = fakeCli(`process.stdout.write(JSON.stringify({ thread: { title: "ran" } }));`);
    expect(await readThread(cli, 'x" & calc & "')).toBeUndefined();
    expect(await readThread(cli, "")).toBeUndefined();
  });

  it("reports nothing when the CLI is missing", async () => {
    expect(await readThread(join(tmpdir(), "does-not-exist", "t3"), "abc")).toBeUndefined();
  });

  it("stops a CLI that hangs, including the process behind the Windows .cmd launcher", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "t3b-pid-")), "pid");
    const hanging = fakeCli(
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       setTimeout(() => process.stdout.write("{}"), 30_000);`,
    );
    const started = Date.now();
    expect(await readThread(hanging, "abc", 1_000)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    // The CLI itself (not just a cmd.exe in front of it) must be gone shortly after.
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(), `CLI process ${pid} is still running`).toBe(false);
  });
});
