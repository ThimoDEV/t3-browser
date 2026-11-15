import { BridgeClient, ensureDaemon } from "./client.js";
import { runDaemon } from "./daemon.js";
import { extensionSteps, install, openExtensionsPage, uninstall } from "./install.js";
import { runMcp, sessionFromEnv } from "./mcp.js";
import { EXTENSION_DIR, LOG_FILE, PORT } from "./paths.js";
import { VERSION } from "./version.js";

const HELP = `t3-browser ${VERSION}: let T3 Code agents use your browser

Usage:
  t3-browser install [--claude] [--codex] [--cursor]   Register the MCP server + skill (default: all found)
  t3-browser uninstall                                 Remove registrations
  t3-browser doctor                                    Check the daemon, the extension and registrations
  t3-browser cdp-url [--session <id>]                  Print a CDP URL for \`agent-browser connect\`
  t3-browser extension-path                            Print the unpacked extension folder
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
      console.log(s.cdpUrl);
      client.close();
      return;
    }
    case "doctor": {
      console.log(`t3-browser ${VERSION}`);
      try {
        await ensureDaemon();
        console.log(`✓ daemon running on 127.0.0.1:${PORT} (log: ${LOG_FILE})`);
      } catch (e) {
        console.log(`✗ daemon: ${(e as Error).message}`);
        process.exitCode = 1;
        return;
      }
      const client = new BridgeClient({ id: "doctor", title: "doctor" });
      const s = await client.call<{ extensionConnected: boolean; extension: { version?: string } }>("daemon.status");
      client.close();
      if (s.extensionConnected) console.log(`✓ Chrome extension connected (v${s.extension.version ?? "?"})`);
      else {
        console.log("✗ Chrome extension not connected. Is Chrome open with the extension loaded?\n");
        console.log(extensionSteps());
        process.exitCode = 1;
      }
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

main(process.argv.slice(2)).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
