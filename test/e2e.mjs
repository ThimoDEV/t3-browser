// End-to-end: real Chrome for Testing + the built extension + the daemon + the MCP server,
// driven through an MCP client exactly like an agent would. A separate DevTools connection
// plays the user (pressing Esc, opening tabs) and checks that no extension window ever pops up:
// there are no permission prompts.
//
//   npx @puppeteer/browsers install chrome@stable --path .cache/browsers
//   npm run test:e2e            (HEADED=1 to watch)

import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import { startFixtures } from "./fixtures.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const PORT = 47900 + Math.floor(Math.random() * 90);
const tmp = mkdtempSync(join(tmpdir(), "t3-browser-e2e-"));
const results = [];
let chrome;
let failed = false;

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(root, ".cache", "browsers", "chrome");
  if (!existsSync(base)) return undefined;
  for (const v of readdirSync(base).sort().reverse()) {
    for (const exe of ["chrome-win64/chrome.exe", "chrome-linux64/chrome", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]) {
      const p = join(base, v, exe);
      if (existsSync(p)) return p;
    }
  }
}

async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push(`✓ ${name} (${Date.now() - t}ms)`);
    console.log(`✓ ${name}`);
  } catch (err) {
    failed = true;
    results.push(`✗ ${name}: ${err.message}`);
    console.log(`✗ ${name}\n  ${err.stack?.split("\n").slice(0, 4).join("\n  ")}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a minimal CDP client for playing "the user" --------------------------------------
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
    this.ready = new Promise((r) => this.ws.once("open", r));
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evalIn(targetId, expression) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    try {
      const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    } finally {
      await this.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  }
}

// ---- setup -----------------------------------------------------------------------------
const exe = findChrome();
if (!exe) {
  console.error("Chrome for Testing not found. Run: npx @puppeteer/browsers install chrome@stable --path .cache/browsers");
  process.exit(2);
}

const fixtures = await startFixtures();
const site = `http://127.0.0.1:${fixtures.address().port}`;
const otherOrigin = `http://localhost:${fixtures.address().port}`;

// Copy the extension and point it at this test's daemon port.
const extDir = join(tmp, "extension");
cpSync(join(root, "extension", "dist"), extDir, { recursive: true });
for (const f of ["background.js", "offscreen.js"]) {
  const p = join(extDir, f);
  writeFileSync(p, readFileSync(p, "utf8").replaceAll("47823", String(PORT)));
}

const profile = join(tmp, "profile");
chrome = spawn(
  exe,
  [
    `--user-data-dir=${profile}`,
    `--load-extension=${extDir}`,
    `--disable-extensions-except=${extDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    ...(process.env.HEADED ? [] : ["--headless=new"]),
    // CI runners (Ubuntu) block the user-namespace sandbox.
    ...(process.env.CI ? ["--no-sandbox"] : []),
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let chromeStderr = "";
chrome.stderr.on("data", (d) => (chromeStderr = (chromeStderr + d).slice(-4000)));

let devtoolsPort;
for (let i = 0; i < 300 && !devtoolsPort; i++) {
  await sleep(100);
  try {
    devtoolsPort = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
  } catch {}
}
assert.ok(devtoolsPort, `Chrome did not start:\n${chromeStderr}`);
const version = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)).json();
const user = new Cdp(version.webSocketDebuggerUrl);
await user.ready;

// Any page the extension opens itself (a prompt window) is a failure: agents never need permission.
const extensionPagesSeen = [];
let watcherOn = true;
(async () => {
  while (watcherOn) {
    try {
      const { targetInfos } = await user.send("Target.getTargets");
      for (const t of targetInfos) {
        if (t.type === "page" && t.url.startsWith("chrome-extension://") && !extensionPagesSeen.includes(t.url)) extensionPagesSeen.push(t.url);
      }
    } catch {}
    await sleep(250);
  }
})();
const assertNoPrompts = () => assert.deepEqual(extensionPagesSeen, [], "the extension must not open any prompt window");

const env = {
  ...process.env,
  T3_BROWSER_HOME: join(tmp, "home"),
  T3_BROWSER_PORT: String(PORT),
  T3_BROWSER_SESSION_ID: "e2e-thread",
  T3_BROWSER_SESSION_TITLE: "E2E",
  AGENT_BROWSER_EXECUTABLE_PATH: exe,
  // Threads that go away are released quickly in this test.
  T3_BROWSER_RELEASE_AFTER_MS: "1500",
};

/** A stand-in for T3 Code's `t3` CLI: one thread, settled once the flag file exists. */
const settledFlag = join(tmp, "thread-settled");
function fakeT3Cli() {
  const script = join(tmp, "fake-t3.mjs");
  writeFileSync(
    script,
    `import { existsSync } from "node:fs";
     process.stdout.write(JSON.stringify({ thread: { title: "Plan the team offsite", settled: existsSync(${JSON.stringify(settledFlag)}), archived: false } }));`,
  );
  if (process.platform === "win32") {
    const cmd = join(tmp, "t3.cmd");
    writeFileSync(cmd, `@"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const sh = join(tmp, "t3");
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

/** Another agent thread: its own MCP server process, as T3 Code would start it. */
async function startAgent(extraEnv) {
  const t = new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "cli.js"), "mcp"], env: { ...env, ...extraEnv }, stderr: "inherit" });
  const c = new Client({ name: "e2e-other", version: "0" });
  await c.connect(t);
  const run = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    const text = r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
    if (r.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { call: run, close: () => c.close() };
}
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "cli.js"), "mcp"], env, stderr: "inherit" });
const mcp = new Client({ name: "e2e", version: "0" });
await mcp.connect(transport);

async function call(name, args = {}) {
  const r = await mcp.callTool({ name, arguments: args });
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (r.isError) {
    const e = new Error(text);
    e.isToolError = true;
    throw e;
  }
  return { ...r, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
}

/** Ask the extension's service worker, e.g. for a tab's group. */
async function inExtension(expression) {
  const { targetInfos } = await user.send("Target.getTargets");
  const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/background.js"));
  assert.ok(sw, "extension service worker not found");
  return user.evalIn(sw.targetId, expression);
}
const groupOf = (tabId) => inExtension(`chrome.tabs.get(${tabId}).then(t => t.groupId)`);

const refOf = (snapshot, pattern) => {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  const m = line && /\[ref=(e\d+)\]/.exec(line);
  if (!m) throw new Error(`no ref matching ${pattern} in:\n${snapshot}`);
  return m[1];
};

// ---- the actual tests ------------------------------------------------------------------
let tab;
let snap;

await step("lists 22 tools with instructions", async () => {
  const { tools } = await mcp.listTools();
  assert.equal(tools.length, 22, tools.map((t) => t.name).join(","));
  assert.match(mcp.getInstructions() ?? "", /untrusted/);
});

await step("extension connects to the daemon", async () => {
  for (let i = 0; i < 60; i++) {
    const s = await call("browser_status");
    if (s.json.bridge.extensionConnected) return;
    await sleep(500);
  }
  throw new Error("extension never connected");
});

await step("name session", async () => {
  await call("browser_name_session", { title: "Signup test" });
});

await step("open needs no approval and lands in the thread's tab group", async () => {
  const r = await call("browser_open", { url: `${site}/form.html` });
  tab = r.json.tab;
  assert.equal(r.json.title, "Signup form");
  assertNoPrompts();
  const status = (await call("browser_status")).json;
  const groupId = status.user.session.groupId;
  assert.ok(groupId >= 0, JSON.stringify(status.user.session));
  assert.equal(await groupOf(tab), groupId, "tab is in the thread group");
  assert.equal(status.user.session.group.title, "T3 · Signup test", "group is named after the thread");
});

await step("a second tab joins the same group, right after the first", async () => {
  const r = await call("browser_open", { url: `${otherOrigin}/page2.html` });
  assertNoPrompts();
  assert.equal(await groupOf(r.json.tab), await groupOf(tab));
  const [a, b] = await inExtension(`Promise.all([chrome.tabs.get(${tab}), chrome.tabs.get(${r.json.tab})]).then(ts => ts.map(t => t.index))`);
  assert.equal(b, a + 1);
  await call("browser_close_tab", { tab: r.json.tab });
});

await step("bare localhost addresses open over http", async () => {
  const r = await call("browser_open", { url: `localhost:${fixtures.address().port}/page2.html` });
  assert.equal(r.json.url, `${otherOrigin}/page2.html`);
  await call("browser_close_tab", { tab: r.json.tab });
});

await step("non-web pages are refused with a clear error", async () => {
  for (const url of ["chrome://settings", "chrome-extension://doaacelnfjdbbfhhkglnkdgboeajnlhk/popup.html", "file:///etc/hosts", "https://chromewebstore.google.com/"]) {
    await assert.rejects(call("browser_open", { url }), /\[restricted\].*only works with web pages/, url);
  }
  await assert.rejects(call("browser_navigate", { tab, url: "chrome://version" }), /\[restricted\]/);
  const mine = (await call("browser_tabs")).json;
  assert.ok(mine.every((t) => !String(t.url).startsWith("chrome")), JSON.stringify(mine));
});

await step("snapshot has refs, roles, iframe content", async () => {
  snap = (await call("browser_snapshot", { tab })).text;
  assert.match(snap, /textbox "Name" \[ref=e\d+\]/);
  assert.match(snap, /combobox "Country" \[ref=e\d+\]/);
  assert.match(snap, /checkbox "I agree" \[ref=e\d+\]/);
  assert.match(snap, /button "Inside frame" \[ref=e\d+\]/, "iframe content grafted in");
  assert.doesNotMatch(snap, /T3 Code is using this tab/, "overlay must not leak into the snapshot");
});

await step("interactive snapshot is flat and short", async () => {
  const s = (await call("browser_snapshot", { tab, interactive: true })).text;
  const lines = s.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(lines.every((l) => /\[ref=e\d+\]/.test(l)), s);
});

await step("type, select, check, submit", async () => {
  await call("browser_type", { tab, ref: refOf(snap, /textbox "Name"/), text: "Ada" });
  await call("browser_select", { tab, ref: refOf(snap, /combobox "Country"/), values: ["Belgium"] });
  await call("browser_click", { tab, ref: refOf(snap, /checkbox "I agree"/) });
  await call("browser_click", { tab, ref: refOf(snap, /button "Send"/) });
  const r = await call("browser_read", { tab, selector: "#out" });
  assert.equal(r.json.text, "Hello Ada from be (agreed)");
});

await step("typing replaces content; press keys works", async () => {
  const name = refOf(snap, /textbox "Name"/);
  await call("browser_type", { tab, ref: name, text: "Grace" });
  await call("browser_press", { tab, keys: ["End", "Backspace"] });
  const v = await call("browser_eval", { tab, expression: "document.querySelector('[name=name]').value" });
  assert.equal(v.json.value, "Grac");
});

await step("click inside an iframe", async () => {
  await call("browser_click", { tab, ref: refOf(snap, /button "Inside frame"/) });
  const v = await call("browser_eval", { tab, expression: "document.querySelector('iframe').contentDocument.querySelector('button').textContent" });
  assert.equal(v.json.value, "Frame clicked");
});

await step("scroll + click far down the page", async () => {
  await call("browser_scroll", { tab, direction: "down", amount: 800 });
  await call("browser_click", { tab, ref: refOf(snap, /button "Bottom button"/) });
  const s = (await call("browser_snapshot", { tab })).text;
  assert.match(s, /button "Bottom clicked"/);
});

await step("wait for late content", async () => {
  await call("browser_click", { tab, ref: refOf(snap, /button "Load later"/) });
  const r = await call("browser_wait", { tab, text: "Loaded later", timeoutMs: 5000 });
  assert.ok(r.json.waitedMs >= 0);
});

await step("alert dialog is reported and can be accepted", async () => {
  await call("browser_click", { tab, ref: refOf(snap, /button "Show alert"/) });
  await sleep(300);
  await assert.rejects(call("browser_snapshot", { tab }), /dialog/);
  await call("browser_dialog", { tab, accept: true });
  await call("browser_snapshot", { tab });
});

await step("screenshot of a background tab", async () => {
  const r = await call("browser_screenshot", { tab });
  const img = r.content.find((c) => c.type === "image");
  assert.ok(img && img.data.length > 5000, "image returned");
  assert.equal(img.mimeType, "image/jpeg");
});

await step("covered element fails loudly instead of mis-clicking", async () => {
  await call("browser_navigate", { tab, url: `${site}/covered.html` });
  const s = (await call("browser_snapshot", { tab })).text;
  await assert.rejects(call("browser_click", { tab, ref: refOf(s, /Hidden behind modal/) }), /covered/);
  await call("browser_click", { tab, ref: refOf(s, /Accept cookies/) });
  await call("browser_click", { tab, ref: refOf(s, /Hidden behind modal/) });
  const t = await call("browser_eval", { tab, expression: "document.title" });
  assert.equal(t.json.value, "clicked");
});

await step("stale refs are rejected", async () => {
  await assert.rejects(call("browser_click", { tab, ref: "e999" }), /stale_ref|Unknown ref/);
});

await step("navigating to another origin just works", async () => {
  const r = await call("browser_navigate", { tab, url: `${otherOrigin}/page2.html` });
  assert.equal(r.json.url, `${otherOrigin}/page2.html`);
  assertNoPrompts();
});

await step("listing all tabs shows web tabs only, without asking", async () => {
  await user.send("Target.createTarget", { url: "chrome://version" });
  const all = (await call("browser_tabs", { scope: "all" })).json;
  assertNoPrompts();
  assert.ok(all.length > 0 && all.every((t) => /^https?:/.test(t.url)), JSON.stringify(all));
});

await step("claiming one of the user's web tabs needs no confirmation", async () => {
  await user.send("Target.createTarget", { url: `${site}/page2.html?mine=user` });
  await sleep(500);
  const all = (await call("browser_tabs", { scope: "all" })).json;
  const theirs = all.find((t) => t.url.endsWith("?mine=user"));
  assert.ok(theirs && !theirs.mine, JSON.stringify(all));
  const claimed = (await call("browser_claim_tab", { tab: theirs.tab })).json;
  assert.equal(claimed.mine, true);
  assertNoPrompts();
  assert.equal(await groupOf(theirs.tab), (await call("browser_status")).json.user.session.groupId);
  await call("browser_close_tab", { tab: theirs.tab });
});

await step("links opening a new tab join the thread", async () => {
  await call("browser_navigate", { tab, url: `${site}/form.html` });
  const s = (await call("browser_snapshot", { tab })).text;
  await call("browser_click", { tab, ref: refOf(s, /Open page two in a new tab/) });
  await sleep(1000);
  const tabs = (await call("browser_tabs")).json;
  assert.ok(tabs.some((t) => t.url.endsWith("/page2.html") && t.mine), JSON.stringify(tabs));
});

await step("Esc hands control back; the agent is told once", async () => {
  const { targetInfos } = await user.send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page" && t.url.endsWith("/form.html"));
  const { sessionId } = await user.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  for (const type of ["keyDown", "keyUp"]) {
    await user.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  }
  await user.send("Target.detachFromTarget", { sessionId });
  await sleep(500);
  await assert.rejects(call("browser_snapshot", { tab }), /interrupted|took back control/);
  // After the agent has been told, it may continue once the user asks it to.
  await call("browser_snapshot", { tab });
});

await step("CDP relay: agent-browser drives the user's tab group", async () => {
  const { json } = await call("browser_cdp_url");
  const ab = (args) =>
    new Promise((resolve, reject) =>
      execFile(process.execPath, [join(root, "node_modules", "agent-browser", "bin", "agent-browser.js"), "--session", "e2e-relay", "--json", ...args], { env, timeout: 60_000 }, (err, stdout, stderr) => {
        const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
        const res = line ? JSON.parse(line) : null;
        if (res?.success) return resolve(res.data);
        reject(new Error(`agent-browser ${args.join(" ")}: ${res?.error?.message ?? res?.error ?? stderr ?? err?.message}`));
      }),
    );
  try {
    await ab(["connect", json.cdpUrl]);
    const tabsList = await ab(["tab", "list"]);
    const formTab = (tabsList.tabs ?? tabsList).find((t) => String(t.url).endsWith("/form.html"));
    assert.ok(formTab, JSON.stringify(tabsList));
    await ab(["tab", formTab.tabId ?? formTab.id]);
    const s = await ab(["snapshot", "-i"]);
    await ab(["fill", "@" + refOf(s.snapshot, /textbox "Name"/), "Linus"]);
    await ab(["click", "@" + refOf(s.snapshot, /button "Send"/)]);
    const r = await call("browser_read", { tab, selector: "#out" });
    assert.match(r.json.text, /Hello Linus/);
  } finally {
    await ab(["close"]).catch(() => {});
  }
});

await step("isolated browser via agent-browser", async () => {
  const r = await call("browser_open", { url: `${site}/form.html`, browser: "isolated" });
  assert.match(r.json.tab, /^iso:/);
  const s = (await call("browser_snapshot", { tab: r.json.tab, interactive: true })).text;
  await call("browser_type", { tab: r.json.tab, ref: refOf(s, /textbox "Name"/), text: "Iso" });
  await call("browser_click", { tab: r.json.tab, ref: refOf(s, /button "Send"/) });
  const out = await call("browser_read", { tab: r.json.tab, selector: "#out" });
  assert.match(out.json.text, /Hello Iso/);
  const shot = await call("browser_screenshot", { tab: r.json.tab });
  assert.ok(shot.content.some((c) => c.type === "image"));
});

await step("in a visible tab the cursor animates, and input still lands", async () => {
  const r = await call("browser_open", { url: `${site}/form.html`, focus: true });
  const t = r.json.tab;
  assert.equal(await inExtension(`chrome.tabs.get(${t}).then(x => x.active)`), true);
  const s = (await call("browser_snapshot", { tab: t })).text;
  const started = Date.now();
  await call("browser_type", { tab: t, ref: refOf(s, /textbox "Name"/), text: "Cursor" });
  await call("browser_select", { tab: t, ref: refOf(s, /combobox "Country"/), values: ["Belgium"] });
  await call("browser_click", { tab: t, ref: refOf(s, /checkbox "I agree"/) });
  await call("browser_click", { tab: t, ref: refOf(s, /button "Send"/) });
  const elapsed = Date.now() - started;
  const out = await call("browser_read", { tab: t, selector: "#out" });
  assert.equal(out.json.text, "Hello Cursor from be (agreed)");
  // Each glide is capped well under a second; four actions must not crawl.
  assert.ok(elapsed < 8000, `four animated actions took ${elapsed}ms`);
  await call("browser_close_tab", { tab: t });
});

await step("the tab group is named after the T3 Code thread, and settling the thread hands the tabs back", async () => {
  const agent = await startAgent({
    T3_BROWSER_SESSION_ID: "e2e-thread-2",
    T3CODE_THREAD_ID: "e2e-thread-2",
    T3CODE_CLI_PATH: fakeT3Cli(),
    T3_BROWSER_SESSION_TITLE: "",
    T3_BROWSER_THREAD_POLL_MS: "300",
  });
  try {
    const opened = await agent.call("browser_open", { url: `${site}/page2.html?thread=2` });
    let status;
    for (let i = 0; i < 25; i++) {
      status = await agent.call("browser_status");
      if (status.user.session.group?.title === "T3 · Plan the team offsite") break;
      await sleep(200);
    }
    assert.equal(status.user.session.group.title, "T3 · Plan the team offsite");
    const groupId = status.user.session.groupId;
    assert.equal(await groupOf(opened.tab), groupId);

    writeFileSync(settledFlag, "");
    let after;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      after = await agent.call("browser_status");
      if (!after.user.tabs.length) break;
    }
    assert.deepEqual(after.user.tabs, [], "the settled thread no longer owns the tab");
    assert.equal(await groupOf(opened.tab), groupId, "the tab stays open in its group");
    const attached = await inExtension(`chrome.debugger.getTargets().then(ts => ts.find(t => t.tabId === ${opened.tab})?.attached)`);
    assert.equal(attached, false, "the debugger is detached");
    await inExtension(`chrome.tabs.remove(${opened.tab})`);
  } finally {
    await agent.close().catch(() => {});
  }
});

await step("a thread whose agent goes away gets its tabs released", async () => {
  const agent = await startAgent({ T3_BROWSER_SESSION_ID: "e2e-thread-3", T3_BROWSER_SESSION_TITLE: "Gone soon" });
  const opened = await agent.call("browser_open", { url: `${site}/page2.html?thread=3` });
  const groupId = await groupOf(opened.tab);
  assert.ok(groupId >= 0);
  assert.equal(await inExtension(`chrome.debugger.getTargets().then(ts => ts.find(t => t.tabId === ${opened.tab})?.attached)`), true);
  await agent.close();
  let attached = true;
  for (let i = 0; i < 25 && attached; i++) {
    await sleep(200);
    attached = await inExtension(`chrome.debugger.getTargets().then(ts => ts.find(t => t.tabId === ${opened.tab})?.attached)`);
  }
  assert.equal(attached, false, "released after the grace period");
  assert.equal(await groupOf(opened.tab), groupId, "the tab stays in its group for the user");
  await inExtension(`chrome.tabs.remove(${opened.tab})`);
});

await step("browser_done keeps chosen tabs and closes the rest", async () => {
  const before = (await call("browser_tabs")).json.filter((t) => t.browser === "user");
  await call("browser_done", { keepTabs: [tab] });
  const { targetInfos } = await user.send("Target.getTargets");
  const pages = targetInfos.filter((t) => t.type === "page");
  assert.ok(pages.some((t) => t.url.endsWith("/form.html")), "kept tab survives");
  assert.ok(before.length >= 2);
  assert.ok(!pages.some((t) => t.url.endsWith("/page2.html")), "other tabs closed");
});

// ---- teardown --------------------------------------------------------------------------
watcherOn = false;
await mcp.close().catch(() => {});
chrome.kill();
fixtures.close();
try {
  const { pid } = JSON.parse(readFileSync(join(tmp, "home", "daemon.json"), "utf8"));
  process.kill(pid);
} catch {}
await sleep(500);
rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });

console.log(`\n${results.length - results.filter((r) => r.startsWith("✗")).length}/${results.length} passed`);
process.exit(failed ? 1 : 0);
