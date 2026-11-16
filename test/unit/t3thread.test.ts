// Tab groups are named after the real T3 Code thread, and a settled or archived thread
// releases its tabs. Both come from `t3 thread show <id> --json`.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localT3Cli, parseThreadJson, readThread, sendToThread } from "../../src/t3thread";
import { fakeCli, recordingCli } from "./fake-cli";

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

describe("sendToThread", () => {
  const outFile = () => join(mkdtempSync(join(tmpdir(), "t3b-send-")), "seen.json");

  it("posts the message through stdin to `t3 thread send <id> -`, untouched by any shell", async () => {
    const out = outFile();
    // Quotes, shell operators, % and newlines: all of them must arrive as typed.
    const message = 'Logged in "as me" & ready | 100% ^done <ok>\n\nNext: the second account.';
    expect(await sendToThread(recordingCli(out), "mcp:abc-123", message)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ args: ["thread", "send", "mcp:abc-123", "-"], stdin: message });
  });

  it("passes on what the CLI said when it fails", async () => {
    const cli = recordingCli(outFile(), 1, "Error: something\nThread mcp:gone is no longer available.\n");
    expect(await sendToThread(cli, "mcp:gone", "hi")).toEqual({ ok: false, error: "Thread mcp:gone is no longer available." });
  });

  it("never runs the CLI for an unexpected thread id", async () => {
    const out = outFile();
    expect(await sendToThread(recordingCli(out), 'x" & calc & "', "hi")).toMatchObject({ ok: false });
    expect(existsSync(out)).toBe(false);
  });

  it("gives up on a CLI that hangs", async () => {
    const started = Date.now();
    expect(await sendToThread(fakeCli("setTimeout(() => {}, 30_000);"), "abc", "hi", 1_000)).toEqual({ ok: false, error: "T3 Code did not answer in time." });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("localT3Cli", () => {
  it("uses the CLI T3 Code points agents at", () => {
    expect(localT3Cli({ T3CODE_CLI_PATH: "/opt/t3/bin/t3" })).toBe("/opt/t3/bin/t3");
  });
});
