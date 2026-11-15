import { BridgeClient, ensureDaemon, isDaemonRunning } from "./client.js";
import { runDaemon } from "./daemon.js";
import { extensionSteps, install, openExtensionsPage, uninstall } from "./install.js";
import { runMcp, sessionFromEnv } from "./mcp.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { DAEMON_FILE, EXTENSION_DIR, LOG_FILE, PORT, readOrCreateToken } from "./paths.js";
import { bridgeEndpoint, checkListenAddress, normalizeBase, readDaemonConfig, readRemoteLink, removeRemoteLink, wsBase, writeDaemonConfig, writeRemoteLink } from "./remote.js";
import { formatSummary, type MethodSummary } from "./stats.js";
import { VERSION } from "./version.js";

const HELP = `t3-browser ${VERSION}: let T3 Code agents use your browser

Usage:
  t3-browser install [--claude] [--codex] [--cursor]   Register the MCP server + skill (default: all found)
  t3-browser uninstall                                 Remove registrations
  t3-browser doctor                                    Check the daemon, the extension and registrations
  t3-browser cdp-url [--session <id>]                  Print a CDP URL for \`agent-browser connect\`
  t3-browser extension-path                            Print the unpacked extension folder
  t3-browser reload-extension                          Make Chrome load the freshly built extension
  t3-browser control                                   Print the link to the control page (what agents do, Stop)
  t3-browser remote [--listen <ip> | --no-listen]      On the machine with Chrome: let agents on other machines use it
  t3-browser remote-link <url> | --off                 On an agent machine: use the Chrome on another machine (asks for the token)
  t3-browser stop                                      Stop the local daemon (the next browser call starts it again)
  t3-browser mcp                                       Run the MCP server on stdio (what agents launch)
  t3-browser daemon                                    Run the bridge daemon in the foreground
`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "mcp":
      return runMcp();
    case "daemon":
      return runDaemon();
    case "install": {
      const picked = (["claude", "codex", "cursor"] as const).filter((t) => rest.includes(`--${t}`));
      for (const line of install(picked.length ? [...picked] : ["claude", "codex", "cursor"])) console.log(line);
      console.log("\n" + extensionSteps());
      if (rest.includes("--open")) openExtensionsPage();
      return;
    }
    case "uninstall":
      for (const line of uninstall()) console.log(line);
      return;
    case "extension-path":
      console.log(EXTENSION_DIR);
      return;
    case "cdp-url": {
      const i = rest.indexOf("--session");
      const session = i >= 0 ? { id: rest[i + 1], title: rest[i + 1] } : sessionFromEnv();
      const client = new BridgeClient(session);
      const s = await client.call<{ cdpUrl: string }>("daemon.status");
      console.log(client.reachable(s.cdpUrl));
      client.close();
      return;
    }
    case "reload-extension": {
      if (!(await isDaemonRunning())) {
        console.log("The daemon is not running, so there is no connected extension to reload. Reload it in chrome://extensions.");
        return;
      }
      const client = new BridgeClient({ id: "reload-extension", title: "reload-extension" });
      try {
        const s = await client.call<{ extensionConnected: boolean }>("daemon.status");
        if (!s.extensionConnected) {
          console.log("The Chrome extension is not connected. Reload it in chrome://extensions.");
          return;
        }
        await client.call("extension.reload");
        console.log("Chrome is reloading T3 Browser from " + EXTENSION_DIR);
      } catch (e) {
        // Builds from before this command existed do not know it.
        console.log(`Could not reload automatically (${(e as Error).message}). Reload T3 Browser once in chrome://extensions.`);
        process.exitCode = 1;
      } finally {
        client.close();
      }
      return;
    }
    case "stop":
      console.log((await stopDaemon()) ? "Stopped the daemon. The next browser call starts it again." : "No daemon was running.");
      return;
    case "control": {
      const endpoint = bridgeEndpoint();
      const bases = endpoint.remote ? [endpoint.base] : [`http://127.0.0.1:${PORT}`, ...runningListen().map((h) => `http://${hostPort(h)}`)];
      console.log("Control page (what agents are doing in Chrome, and a Stop button). The link contains a secret: keep it to yourself.\n");
      for (const b of bases) console.log(`  ${b}/control?token=${endpoint.token}`);
      if (!endpoint.remote && !runningListen().length) console.log("\nTo open it on your phone, see `t3-browser remote --listen <your Tailscale IP>`.");
      return;
    }
    case "remote":
      return remoteCommand(rest);
    case "remote-link":
      return remoteLinkCommand(rest);
    case "doctor": {
      console.log(`t3-browser ${VERSION}`);
      const link = readRemoteLink();
      if (link) console.log(`→ linked to the Chrome on another machine: ${link.url} (\`t3-browser remote-link --off\` to undo)`);
      try {
        await ensureDaemon();
        const ep = bridgeEndpoint();
        console.log(ep.remote ? `✓ daemon on the other machine answers at ${ep.base}` : `✓ daemon running on 127.0.0.1:${PORT} (log: ${LOG_FILE})`);
      } catch (e) {
        console.log(`✗ daemon: ${(e as Error).message}`);
        process.exitCode = 1;
        return;
      }
      const client = new BridgeClient({ id: "doctor", title: "doctor" });
      const s = await client.call<{ extensionConnected: boolean; extension: { version?: string }; stats?: Record<string, MethodSummary> }>("daemon.status");
      client.close();
      if (s.extensionConnected) console.log(`✓ Chrome extension connected (v${s.extension.version ?? "?"})`);
      else {
        console.log("✗ Chrome extension not connected. Is Chrome open with the extension loaded?\n");
        console.log(extensionSteps());
        process.exitCode = 1;
      }
      if (s.stats) console.log(`
Calls into Chrome since the daemon started:
${formatSummary(s.stats)}`);
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    default:
      console.error(`Unknown command ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

// ---- Remote use ----------------------------------------------------------------------------

function hostPort(host: string): string {
  return `${host.includes(":") ? `[${host.replace(/^\[|\]$/g, "")}]` : host}:${PORT}`;
}

/** Extra addresses the running daemon actually listens on. */
function runningListen(): string[] {
  try {
    return (JSON.parse(readFileSync(DAEMON_FILE, "utf8")).listen as string[]) ?? [];
  } catch {
    return [];
  }
}

async function stopDaemon(): Promise<boolean> {
  if (!(await isDaemonRunning({ base: `http://127.0.0.1:${PORT}`, token: "", remote: false }))) return false;
  try {
    process.kill(Number(JSON.parse(readFileSync(DAEMON_FILE, "utf8")).pid));
  } catch {
    return false;
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, 100));
    if (!(await isDaemonRunning({ base: `http://127.0.0.1:${PORT}`, token: "", remote: false }))) return true;
  }
  return false; // still answering
}

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let line = "";
    process.stdin.setEncoding("utf8");
    const onData = (d: string) => {
      line += d;
      const nl = line.indexOf("\n");
      if (nl < 0) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(line.slice(0, nl).replace(/\r$/, ""));
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", () => resolve(line));
  });
}

function tailscaleIp(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("tailscale", ["ip", "-4"], { timeout: 3_000, windowsHide: true }, (err, out) => resolve(err ? undefined : String(out).trim().split(/\s+/)[0] || undefined));
  });
}

async function remoteCommand(args: string[]): Promise<void> {
  if (readRemoteLink()) {
    console.log("This machine is itself linked to the Chrome on another machine. Run `t3-browser remote` on that machine instead.");
    return;
  }
  const i = args.indexOf("--listen");
  if (i >= 0 || args.includes("--no-listen")) {
    const listen = i >= 0 ? [args[i + 1] ?? ""] : [];
    for (const host of listen) {
      const problem = checkListenAddress(host);
      if (problem) {
        console.log(`✗ ${problem}`);
        process.exitCode = 1;
        return;
      }
    }
    writeDaemonConfig({ listen });
    await stopDaemon();
    await ensureDaemon({ base: `http://127.0.0.1:${PORT}`, token: readOrCreateToken(), remote: false });
    const now = runningListen();
    if (listen.length && !now.length) {
      console.log(`✗ The daemon could not listen on ${listen[0]} (is that this machine's address, and is Tailscale up?). See ${LOG_FILE}.`);
      process.exitCode = 1;
      return;
    }
    console.log(listen.length ? `✓ The daemon now also listens on ${hostPort(listen[0])}.` : "✓ The daemon listens on this machine only again.");
  }

  const token = readOrCreateToken();
  const listening = runningListen().length ? runningListen() : readDaemonConfig().listen;
  console.log("Let agents on other machines (a VPS, a linked T3 Code environment) use the Chrome on this machine.");
  console.log("The token below gives full control of that Chrome: treat it like a password.\n");
  if (listening.length) {
    console.log("On the agent machine, run:");
    for (const h of listening) console.log(`  t3-browser remote-link ws://${hostPort(h)}`);
    console.log(`and paste this token when it asks:\n  ${token}`);
  } else {
    const ts = await tailscaleIp();
    console.log("Option 1, Tailscale (recommended; encrypted, works from anywhere on your tailnet):");
    console.log(`  t3-browser remote --listen ${ts ?? "<this machine's Tailscale IP, from \`tailscale ip -4\`>"}`);
    console.log("  then run the remote-link command it prints on the agent machine.\n");
  }
  console.log(`${listening.length ? "\nOr, without" : "Option 2, without"} listening on the network: an SSH tunnel from this machine to the agent machine:`);
  console.log(`  ssh -N -R ${PORT}:127.0.0.1:${PORT} <user>@<agent-machine>`);
  console.log(`  and on the agent machine: t3-browser remote-link ws://127.0.0.1:${PORT}   (token: ${token})`);
  console.log("\nEither way, start a new thread on the agent machine afterwards (MCP servers read the link when they start).");
}

async function remoteLinkCommand(args: string[]): Promise<void> {
  if (args[0] === "--off") {
    console.log(removeRemoteLink() ? "✓ Unlinked. Agents here use the Chrome on this machine again." : "This machine was not linked.");
    return;
  }
  const url = args[0];
  if (!url) {
    console.log("Usage: t3-browser remote-link <ws://host:port>   (it asks for the token; run `t3-browser remote` on the machine with Chrome to get both)");
    process.exitCode = 1;
    return;
  }
  // Asked for, not an argument by default: arguments end up in shell history and process lists.
  const token = (args[1] ?? process.env.T3_BROWSER_TOKEN ?? (await readLine("Token (from `t3-browser remote` on the Chrome machine): "))).trim();
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    console.log("✗ That does not look like a T3 Browser token (64 hex characters).");
    process.exitCode = 1;
    return;
  }
  const endpoint = { base: normalizeBase(url), token, remote: true };
  if (!(await isDaemonRunning(endpoint))) {
    console.log(`✗ Nothing answers at ${wsBase(endpoint.base)}. Is the other machine on, and Tailscale (or the SSH tunnel) up?`);
    process.exitCode = 1;
    return;
  }
  const client = new BridgeClient({ id: "remote-link", title: "remote-link" }, endpoint);
  try {
    const s = await client.call<{ extensionConnected: boolean }>("daemon.status");
    writeRemoteLink(url, token);
    console.log(`✓ Linked: agents on this machine now use the Chrome at ${wsBase(endpoint.base)}${s.extensionConnected ? "" : " (its extension is not connected right now)"}.`);
    console.log("Start a new thread for it to take effect. `t3-browser remote-link --off` undoes it.");
  } catch (e) {
    console.log(`✗ The daemon there refused the token (${(e as Error).message}).`);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
