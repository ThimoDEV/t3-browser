# T3 Browser

Let [T3 Code](https://github.com/pingdotgg/t3code) agents use your browser.

## What's new

- **No permission prompts.** With the extension installed and connected, agents just open pages, see your web tabs, take one over and upload files. You watch it happen in the tab and press **Esc** to take over.
- **Tabs land in the thread's tab group.** New tabs open in the background, right inside a group named after the thread, created on demand.
- **Web pages only.** http and https, localhost included. Browser pages, extension pages, local files and the Chrome Web Store are refused with a clear `[restricted]` error.
- **A visible agent cursor.** In a tab you're watching, a purple "T3 Code" cursor glides to each element and shows the click or "Typing…" before the real input is sent.
- **No silent hangs.** Opening a tab can no longer wait on an unseen prompt until the bridge times out.
- **Self-updating extension.** `pnpm reload` builds and makes the connected Chrome load the new extension, no trip to `chrome://extensions`.
- **Agents on other machines.** An agent on a VPS or a linked T3 Code environment can use the Chrome on your desk, over Tailscale or an SSH tunnel. See [Use it from another machine](#use-it-from-another-machine).
- **A control page for your phone.** What each thread is doing in Chrome, a peek at its tabs, and Stop. See [Control page](#control-page).
- **Quiet when idle.** Chrome's "started debugging this browser" bar goes away once an agent has been idle for a minute, and comes back when it acts again.

It works like the Codex Chrome extension, for every agent T3 Code runs (Claude Code, Codex, Cursor):

- **Your real Chrome, your sign-ins.** An agent works in its own tab group named after the thread, in the background, next to your own tabs. With the extension installed and connected, `browser_open` just opens the page in that group. There are no permission prompts at all.
- **Web pages only.** Agents get http and https pages (localhost included). Browser pages (`chrome://`, `chrome-extension://`, `devtools://`), local files and the Chrome Web Store are refused.
- **Each thread has a number and a colour.** Thread #1 is T3 purple, the next gets the next free colour. The same number and colour show up on its tab group ("T3 #2 · Fix login"), the overlay on its pages (frame, pill, cursor), the toolbar badge on its tabs, and its row in the popup ("Show" selects its tabs). Recolour a group in Chrome and the thread follows. The page's own tab icon is left alone on purpose: Chrome would remember a borrowed icon in your history and bookmarks.
- **Several threads at once, without fighting over your screen.** Agents work in background tabs. A screenshot of a hidden tab briefly brings it forward, one at a time, and puts your tab back unless you moved on; a popup that an agent's background tab opens is sent back behind your tab; agent-browser's "bring to front" is ignored. Only `browser_open` with `focus: true` brings a tab forward.
- **Quick tasks can skip the group.** Untick "Group a thread's tabs from its first tab" in the popup and a one-tab task stays ungrouped (marked by its badge and overlay); the group appears with its second tab.
- **Groups follow the thread.** The tab group carries the T3 Code thread's real title (read through T3 Code's `t3` CLI). When you settle or archive the thread, or its agent goes away for two minutes, its tabs are handed back: they stay open in a collapsed group, with the debugger and overlay gone. The extension popup and the "T3 Code is using this tab" pill on the page link straight to the thread.
- **You see what it does.** When you watch a controlled tab, the agent's own cursor (a purple arrow tagged "T3 Code") glides to each element and shows the click or "Typing…" before the real input is sent. In background tabs it skips the animation, so nothing slows down.
- **You stay in charge.** Pressing **Esc** on a controlled tab, or clicking **Stop**, hands control straight back, and the agent is told to stop and ask you.
- **Plus a clean browser.** For public pages and local dev servers, agents can use an isolated Chrome driven by Vercel's [agent-browser](https://github.com/vercel-labs/agent-browser). It has no cookies.
- **agent-browser on your real tabs.** The bridge exposes a CDP endpoint scoped to the thread's tab group, so `agent-browser connect` (or Playwright) can drive your signed-in tabs, with the same limits.

```
T3 Code thread ─▶ Claude Code / Codex / Cursor
                     │ MCP (stdio): browser_open, browser_snapshot, browser_click, …
                     ▼
               t3-browser mcp ──────────────▶ agent-browser ──▶ isolated Chrome
                     │ ws /client (token)
                     ▼
               t3-browser daemon  ◀── ws /cdp/<thread> ── agent-browser connect (power mode)
               127.0.0.1:47823
                     │ ws /extension (Origin = pinned extension ID)
                     ▼
               T3 Browser extension ──chrome.debugger (CDP)──▶ your tabs
```

## Install

Requires Node 20+, [pnpm](https://pnpm.io/installation) and Chrome (or Edge, Brave and other Chromium browsers).

```sh
git clone https://github.com/ThimoDEV/t3-browser
cd t3-browser
pnpm install
pnpm build
node dist/cli.js install        # registers the MCP server + skill with claude, codex and cursor
```

Then load the extension once:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/dist` folder (`node dist/cli.js extension-path` prints it).
3. Pin **T3 Browser** to the toolbar. Its popup shows connection status, each thread with its number and colour, and **Show** / **Stop** buttons. On an agent's tab the icon's badge shows that thread's number.

After pulling a new version, run `pnpm reload`: it builds and tells the connected Chrome to load the new extension. (Builds from before this command need one manual click on the reload icon in `chrome://extensions`.)

Start a **new** thread in T3 Code (MCP servers load when a session starts) and ask something like *"check my GitHub notifications and summarise the ones about t3code"*.

`node dist/cli.js doctor` checks that the daemon is running and the extension is connected, and shows how long each kind of call into Chrome has taken (count, p50, p95, max). Slow (over 5s) and failed calls are also written to `~/.t3-browser/daemon.log`. `node dist/cli.js uninstall` removes the registrations.

## Commands

| Command | What it does |
| --- | --- |
| `node dist/cli.js install` | Register the MCP server and skill with Claude Code, Codex and Cursor |
| `node dist/cli.js doctor` | Check the daemon and the extension, and show how long calls into Chrome take |
| `pnpm reload` | Build, then make the connected Chrome load the new extension |
| `node dist/cli.js control` | Print the link to the control page (open it on your phone over Tailscale) |
| `node dist/cli.js remote --listen <ip>` | Let agents on other machines use the Chrome on this machine |
| `node dist/cli.js remote-link <url>` | On an agent machine: use the Chrome on another machine (asks for the token) |
| `node dist/cli.js stop` | Stop the daemon; the next browser call starts it again |

## Control page

`node dist/cli.js control` prints a link (it carries the daemon's token once, then a cookie takes over). The page lists every thread that used Chrome since the daemon started: its tabs, its recent actions ("opened https://…", "typed 12 characters", never the text itself or URL query strings), a **Peek** button that screenshots a tab, and **Stop** (per thread, or all). Stop works like pressing Esc: the agent is told to stop and ask you.

To open it on your phone, let the daemon listen on your Tailscale address (next section) and open the printed `http://100.x.y.z:47823/control?token=…` link on the phone.

## Use it from another machine

When T3 Code runs an agent somewhere else (a VPS, a linked environment), that agent can still use the Chrome on your desk. The daemon stays next to Chrome; the agent machine is linked to it with the daemon's address and token.

On the machine with Chrome:

```sh
node dist/cli.js remote --listen 100.x.y.z   # your Tailscale IP (`tailscale ip -4`); prints the command for the agent machine
```

On the agent machine (with t3-browser installed there too):

```sh
node dist/cli.js remote-link ws://100.x.y.z:47823   # asks for the token; then start a new thread
```

Without Tailscale, use an SSH tunnel and keep the daemon on loopback: `ssh -N -R 47823:127.0.0.1:47823 you@agent-machine` from the Chrome machine, then `remote-link ws://127.0.0.1:47823` on the agent machine. `remote-link --off` and `remote --no-listen` undo it.

What changes for a linked agent: nothing in how it works. Its tab group, Esc, Stop and the control page behave the same. Files it uploads are sent from its machine and written to a private, short-lived folder next to Chrome (40MB total per upload). The isolated browser still runs on the agent's own machine.

The daemon only listens on specific private addresses (loopback, LAN, Tailscale's 100.64.0.0/10, IPv6 unique-local), never on `0.0.0.0` or a public IP, and the extension endpoint only accepts Chrome on the same machine. The token is the key to your browser, and to files on the Chrome machine (an agent can ask Chrome to upload any local path): Tailscale (encrypted) or SSH are the recommended routes, and on a shared LAN anyone sniffing plain traffic could read it. `remote-link` asks for the token rather than taking it as an argument, so it stays out of shell history.

With an SSH tunnel, every connection reaches the daemon as if from this machine, so processes on the agent machine could try to pose as the extension. The daemon only accepts a second extension connection when the current one has stopped answering, so this can only happen while Chrome is closed or the extension is off.

The daemon keeps running while remote use is set up (a remote agent cannot start it), and retries a listen address that was not available yet, such as Tailscale coming up after boot.

## What agents get

| Tool | Does |
| --- | --- |
| `browser_open` | New tab in the thread's tab group in the user's Chrome (default), or `browser: "isolated"` |
| `browser_tabs` / `browser_claim_tab` | List this thread's tabs, or all of the user's web tabs, and take one over into the thread's group |
| `browser_snapshot` | Accessibility tree with refs: `- button "Send" [ref=e6]`; `interactive: true` for a flat short list; includes same-process iframes |
| `browser_click` / `browser_type` / `browser_press` / `browser_select` / `browser_hover` / `browser_scroll` | Real input events through CDP. Clicks fail with `[covered]` instead of mis-clicking under a modal |
| `browser_read` / `browser_screenshot` / `browser_eval` / `browser_wait` | Read text (paged), capture (works for background tabs too), evaluate JS, wait for text/selector/URL/load |
| `browser_upload` / `browser_dialog` | File inputs, `alert`/`confirm`/`prompt` |
| `browser_navigate` / `browser_close_tab` / `browser_name_session` / `browser_done` | Navigation, cleanup, naming the tab group, handing back control |
| `browser_cdp_url` | CDP endpoint for `agent-browser connect` on the user's tabs |
| `browser_status` | Is the extension connected, which tabs are mine |

The server also sends usage and safety instructions in its MCP `initialize` response, and installs a `t3-browser` skill for Claude Code and Codex.

## Security model

- The daemon binds `127.0.0.1`, plus private addresses you add with `remote --listen` (never a wildcard or public address). The extension endpoint accepts loopback connections only.
- The browser side accepts exactly one Origin: `chrome-extension://doaacelnfjdbbfhhkglnkdgboeajnlhk`. The ID is pinned by the public key in the manifest, and web pages cannot forge that Origin.
- Local clients (the MCP server, CDP clients) need the random token in `~/.t3-browser/token`, and any connection that carries a web Origin is refused even if it has the token. A page that finds the port still can't drive the browser.
- The extension only works on web pages (http/https). It refuses browser-internal pages, extension pages, local files and the Web Store, for opening, navigating, acting and claiming alike. It never asks for permission: opening sites, listing your web tabs, taking one over and uploads just happen, and you watch (and stop) it in the tab itself. The agent instructions say to upload only files you asked for.
- Agents only touch tabs in their own group. Another thread's tab is off limits (`[ownership_conflict]`).
- The agent instructions treat page content as untrusted, and agents must confirm in chat before sending, buying, deleting or changing account settings.

## How it compares

| | Codex Chrome extension | T3 Browser |
| --- | --- | --- |
| Agents | Codex | Whatever T3 Code runs: Claude Code, Codex, Cursor (anything that speaks MCP) |
| Transport | Native messaging host + named pipe | Localhost WebSocket with Origin + token auth (no installer or registry keys) |
| Page model | AX tree / DOM / Playwright-style locators in a JS REPL | MCP tools over an agent-browser-compatible AX snapshot with `@eN` refs |
| Isolated browser | In-app browser | agent-browser (headless or headed Chrome) |
| Raw CDP | Per-tab `cdp.send` | Full browser-level CDP endpoint per thread (agent-browser, Playwright) |

## Development

```sh
pnpm dev             # rebuild CLI + extension on change (reload the extension in chrome://extensions)
pnpm reload          # build, then make the connected Chrome load the new extension build
pnpm typecheck
pnpm test            # unit tests: snapshot formatter, keys, daemon auth + routing
pnpm dlx @puppeteer/browsers install chrome@stable --path .cache/browsers
pnpm test:e2e        # real Chrome for Testing + extension + daemon + MCP, end to end (HEADED=1 to watch)
```

The e2e suite runs the whole chain through an MCP client and fails if the extension ever opens a prompt window. It covers opening into the thread's tab group, claiming the user's tab, refusing non-web pages, Esc takeover, dialogs, iframes, covered elements, background-tab screenshots, new-tab adoption, the agent-browser CDP relay and the isolated browser.

Environment: `T3_BROWSER_PORT` (default 47823, change the extension's port in its storage too), `T3_BROWSER_HOME` (default `~/.t3-browser`), `T3_BROWSER_SESSION_ID` / `T3_BROWSER_SESSION_TITLE` (default: `T3CODE_THREAD_ID`, and the thread's title from `T3CODE_CLI_PATH` or else the project folder name), `T3_BROWSER_RELEASE_AFTER_MS` (default 120000: how long a thread's agent may be gone before its tabs are released), `T3_BROWSER_THREAD_POLL_MS` (default 60000), `T3_BROWSER_DEBUG=1` (log every call).

## Limits

- Cross-process (out-of-process) iframes don't show up in `browser_snapshot` yet. Use `browser_cdp_url` with agent-browser for those pages.
- Chrome shows its own "T3 Browser started debugging this browser" bar while an agent is attached. Clicking **Cancel** on it also stops the agent.
- The extension isn't on the Web Store yet, so it is loaded unpacked.
