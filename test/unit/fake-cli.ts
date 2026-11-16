// A stand-in for T3 Code's `t3` CLI, for tests that run it for real.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A CLI that runs `body` (a Node module with `args` in scope). On Windows it is a .cmd launcher,
 * like the real `t3.cmd`.
 */
export function fakeCli(body: string): string {
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

/** A CLI that records its arguments and stdin as JSON in `out`, then exits with `code`. */
export function recordingCli(out: string, code = 0, stderr = ""): string {
  return fakeCli(
    `import { readFileSync, writeFileSync } from "node:fs";
     writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args, stdin: readFileSync(0, "utf8") }));
     if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});
     process.exit(${code});`,
  );
}
