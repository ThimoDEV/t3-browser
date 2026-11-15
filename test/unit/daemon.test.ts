// The daemon is the security boundary: only the pinned extension may connect as the browser,
// and only local processes holding the token (and no web Origin) may drive it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const PORT = 48100 + Math.floor(Math.random() * 500);
process.env.T3_BROWSER_HOME = mkdtempSync(join(tmpdir(), "t3b-unit-"));
process.env.T3_BROWSER_PORT = String(PORT);
/** How long a thread may be gone before the daemon releases its tabs (shortened for tests). */
const GRACE_MS = 300;
/** Long enough that a release would have happened by now if one were coming. */
const PAST_GRACE_MS = GRACE_MS * 2 + 100;
process.env.T3_BROWSER_RELEASE_AFTER_MS = String(GRACE_MS);
// A second loopback address stands in for a Tailscale IP; the public one must be refused.
process.env.T3_BROWSER_LISTEN = "127.0.0.2,8.8.8.8";

const { Daemon } = await import("../../src/daemon");
const { EXTENSION_ID } = await import("../../src/protocol");

let daemon: InstanceType<typeof Daemon>;

function connect(path: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", () => reject(new Error("rejected")));
  });
}

/** The next message on ws that matches, or undefined after ms. */
function waitFor(ws: WebSocket, match: (m: any) => boolean, ms = 2_000): Promise<any> {
  return new Promise((resolve) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const m = JSON.parse(raw.toString());
      if (!match(m)) return;
      cleanup();
      resolve(m);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
    };
    ws.on("message", onMessage);
  });
}

/** Close ws and resolve once the closing handshake is done (the daemon has seen it). */
function closeAndWait(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

/** Resolve once the daemon's public health check reports no Chrome extension. */
async function extensionGone(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    if (!health.extensionConnected) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the daemon never noticed the extension disconnect");
}

function next(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
}

const OLD_UPLOAD = join(process.env.T3_BROWSER_HOME!, "uploads", "from-last-run", "cv.pdf");

beforeAll(async () => {
  // A file a remote agent uploaded before the daemon restarted.
  mkdirSync(join(OLD_UPLOAD, ".."), { recursive: true });
  writeFileSync(OLD_UPLOAD, "old");
  daemon = new Daemon(PORT);
  await daemon.start();
});
afterAll(() => {
  // the process exits with the test runner
});

describe("daemon auth", () => {
  it("rejects an extension connection from a web origin", async () => {
    await expect(connect("/extension", { origin: "https://evil.example" })).rejects.toThrow();
  });

  it("rejects an extension connection from another extension", async () => {
    await expect(connect("/extension", { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).rejects.toThrow();
  });

  it("rejects clients without the token", async () => {
    await expect(connect("/client")).rejects.toThrow();
    await expect(connect("/client", { authorization: "Bearer nope" })).rejects.toThrow();
  });

  it("rejects clients that carry a web Origin even with the token", async () => {
    await expect(connect("/client", { authorization: `Bearer ${daemon.token}`, origin: "http://localhost:3000" })).rejects.toThrow();
    await expect(connect(`/cdp/x?token=${daemon.token}`, { origin: "https://evil.example" })).rejects.toThrow();
  });

  it("health reveals nothing secret", async () => {
    const body = await (await fetch(`http://127.0.0.1:${PORT}/health`)).text();
    expect(body).not.toContain(daemon.token);
    expect(JSON.parse(body).name).toBe("t3-browser");
  });
});

describe("routing", () => {
  it("forwards a client request to the extension and the answer back", async () => {
    const ext = await connect("/extension", { origin: `chrome-extension://${EXTENSION_ID}` });
    ext.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, version: "test" }));
    const client = await connect("/client", { authorization: `Bearer ${daemon.token}` });

    const seen = next(ext);
    client.send(JSON.stringify({ type: "request", id: 7, session: { id: "s1", title: "T" }, method: "tabs.list", params: { scope: "session" } }));
    const req = await seen;
    expect(req).toMatchObject({ type: "request", method: "tabs.list", session: { id: "s1" } });

    const answer = next(client);
    ext.send(JSON.stringify({ type: "response", id: req.id, result: [{ tabId: 1 }] }));
    expect(await answer).toEqual({ type: "response", id: 7, result: [{ tabId: 1 }] });

    const status = next(client);
    client.send(JSON.stringify({ type: "request", id: 8, session: { id: "s1", title: "T" }, method: "daemon.status" }));
    expect((await status).result).toMatchObject({ extensionConnected: true, extension: { version: "test" } });

    // An extension that disconnects mid-request fails the request instead of hanging it.
    const pending = next(client);
    const lost = next(ext);
    client.send(JSON.stringify({ type: "request", id: 9, session: { id: "s1", title: "T" }, method: "page.read", params: {} }));
    await lost;
    ext.close();
    expect((await pending).error).toMatchObject({ code: "no_extension" });
    client.close();
  });
});

describe("threads that go away", () => {
  const releaseFor = (id: string) => (m: any) => m.type === "request" && m.method === "session.release" && m.session?.id === id;

  async function fakeExtension() {
    const ext = await connect("/extension", { origin: `chrome-extension://${EXTENSION_ID}` });
    ext.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, version: "test" }));
    // Answer every request so calls complete.
    ext.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "request") ext.send(JSON.stringify({ type: "response", id: m.id, result: { ok: true } }));
    });
    return ext;
  }

  async function request(ws: WebSocket, session: string, method: string, params: Record<string, unknown> = {}) {
    const answered = next(ws);
    ws.send(JSON.stringify({ type: "request", id: 1, session: { id: session, title: "T" }, method, params }));
    return answered;
  }

  async function client(session: string, method = "tabs.open") {
    const ws = await connect("/client", { authorization: `Bearer ${daemon.token}` });
    await request(ws, session, method);
    return ws;
  }

  it("releases a thread's tabs, keeping them in their group, once its MCP server is gone", async () => {
    const ext = await fakeExtension();
    const c = await client("gone-1");
    const release = waitFor(ext, releaseFor("gone-1"));
    c.close();
    expect((await release)?.params).toEqual({ closeTabs: false, keepGroup: true });
    ext.close();
  });

  it("does not release while another connection still serves the thread", async () => {
    const ext = await fakeExtension();
    const a = await client("gone-2");
    const b = await client("gone-2", "daemon.status");
    a.close();
    expect(await waitFor(ext, releaseFor("gone-2"), PAST_GRACE_MS)).toBeUndefined();
    const release = waitFor(ext, releaseFor("gone-2"));
    b.close();
    expect(await release).toBeDefined();
    ext.close();
  });

  it("does not release a thread that reconnects in time", async () => {
    const ext = await fakeExtension();
    (await client("gone-3")).close();
    const back = await client("gone-3", "status");
    expect(await waitFor(ext, releaseFor("gone-3"), PAST_GRACE_MS)).toBeUndefined();
    back.close();
    expect(await waitFor(ext, releaseFor("gone-3"))).toBeDefined();
    ext.close();
  });

  it("does not release again after the agent called browser_done", async () => {
    const ext = await fakeExtension();
    const c = await client("gone-4");
    await request(c, "gone-4", "session.release", { keepTabIds: [] });
    c.close();
    expect(await waitFor(ext, (m) => releaseFor("gone-4")(m) && m.params?.keepGroup, PAST_GRACE_MS)).toBeUndefined();
    ext.close();
  });

  it("retries a release that could not reach Chrome once the extension is back", async () => {
    const ext = await fakeExtension();
    const c = await client("gone-5");
    ext.close();
    await extensionGone();
    await closeAndWait(c);
    // Deliberately outwait the grace period: the release must come due while Chrome is away,
    // or this would pass without any retry logic.
    await new Promise((r) => setTimeout(r, PAST_GRACE_MS));
    const back = await fakeExtension();
    expect(await waitFor(back, releaseFor("gone-5"))).toBeDefined();
    back.close();
  });

  it("ignores CDP relay clients when deciding whether a thread is still there", async () => {
    const ext = await fakeExtension();
    const c = await client("gone-6");
    const relay = await connect(`/cdp/gone-6?token=${daemon.token}`);
    const release = waitFor(ext, releaseFor("gone-6"));
    c.close();
    expect(await release).toBeDefined();
    relay.close();
    ext.close();
  });

  it("still releases when a relay makes calls after the agent is gone", async () => {
    const ext = await fakeExtension();
    const c = await client("gone-7");
    const relay = await connect(`/cdp/gone-7?token=${daemon.token}`);
    await closeAndWait(c);
    // The relay keeps talking to Chrome after the agent is gone (Target.getTargets makes the
    // daemon call tabs.list for the thread). That must not cancel the pending release.
    const answered = next(relay);
    relay.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    await answered;
    expect(await waitFor(ext, releaseFor("gone-7"))).toBeDefined();
    relay.close();
    ext.close();
  });

  it("times every call into Chrome", async () => {
    const ext = await fakeExtension();
    const c = await client("timed", "page.snapshot");
    const status = await request(c, "timed", "daemon.status");
    expect(status.result.stats["page.snapshot"]).toMatchObject({ count: 1, errors: 0 });
    c.close();
    ext.close();
  });
});

describe("remote agents", () => {
  it("also listens on the configured private address, and never on a public one", async () => {
    expect(daemon.listen).toEqual(["127.0.0.2"]);
    const health = await (await fetch(`http://127.0.0.2:${PORT}/health`)).json();
    expect(health.name).toBe("t3-browser");
  });

  it("turns a remote agent's upload into files on this machine", async () => {
    const ext = await connect("/extension", { origin: `chrome-extension://${EXTENSION_ID}` });
    ext.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, version: "test" }));
    const client = await connect("/client", { authorization: `Bearer ${daemon.token}` });
    const forwarded = waitFor(ext, (m) => m.method === "page.upload");
    client.send(
      JSON.stringify({
        type: "request",
        id: 1,
        session: { id: "remote-up", title: "T" },
        method: "page.upload",
        params: { tabId: 3, ref: "e2", inlineFiles: [{ name: "cv.pdf", data: Buffer.from("%PDF hello").toString("base64") }] },
      }),
    );
    const req = await forwarded;
    expect(req.params.inlineFiles).toBeUndefined();
    expect(req.params.files).toHaveLength(1);
    expect(readFileSync(req.params.files[0], "utf8")).toBe("%PDF hello");
    client.close();
    ext.close();
  });
});

describe("control page", () => {
  /** Raw HTTP so tests can send any Host header (fetch does not allow setting it). */
  function http(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: PORT, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end(opts.body);
    });
  }

  async function signIn(): Promise<string> {
    const res = await http(`/control?token=${daemon.token}`);
    return String(res.headers["set-cookie"]).split(";")[0];
  }

  /** An extension that owns one tab for every thread and records what it is asked. */
  async function fakeExtensionWithTab() {
    const ext = await connect("/extension", { origin: `chrome-extension://${EXTENSION_ID}` });
    ext.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, version: "test" }));
    ext.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== "request") return;
      const result = m.method === "status" ? { tabs: [{ tabId: 5, title: "Inbox", url: "https://mail.example/inbox?auth=SECRET" }] } : { ok: true };
      ext.send(JSON.stringify({ type: "response", id: m.id, result }));
    });
    return ext;
  }

  it("refuses visitors without the token", async () => {
    expect((await http("/control")).status).toBe(401);
    expect((await http("/control?token=wrong")).status).toBe(401);
    expect((await http("/control/state")).status).toBe(401);
  });

  it("swaps the token for an HttpOnly, SameSite=Lax cookie", async () => {
    const res = await http(`/control?token=${daemon.token}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/control");
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toContain(daemon.token);
    const page = await http("/control", { headers: { cookie: cookie.split(";")[0] } });
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toMatch(/default-src 'self'/);
  });

  it("answers only to the addresses it listens on (no DNS rebinding)", async () => {
    const cookie = await signIn();
    expect((await http("/control/state", { headers: { cookie, host: "evil.example:47823" } })).status).toBe(421);
    expect((await http("/control/state", { headers: { cookie, host: `127.0.0.2:${PORT}` } })).status).toBe(200);
  });

  it("shows each thread's tabs and actions, without URL queries", async () => {
    const ext = await fakeExtensionWithTab();
    const client = await connect("/client", { authorization: `Bearer ${daemon.token}` });
    const answered = next(client);
    client.send(JSON.stringify({ type: "request", id: 1, session: { id: "ctl-1", title: "Book dentist", link: "https://app.t3.codes/threads/x" }, method: "tabs.open", params: { url: "https://dentist.example/?ref=ads" } }));
    await answered;

    const state = JSON.parse((await http("/control/state", { headers: { cookie: await signIn() } })).body);
    const thread = state.threads.find((t: any) => t.id === "ctl-1");
    expect(thread).toMatchObject({ title: "Book dentist", link: "https://app.t3.codes/threads/x", connected: true, controlling: true });
    expect(thread.tabs).toEqual([{ tabId: 5, title: "Inbox", url: "https://mail.example/inbox" }]);
    expect(thread.activity[0].text).toBe("opened https://dentist.example");
    client.close();
    ext.close();
  });

  it("stops a thread, but only for a same-origin request from the page", async () => {
    const ext = await fakeExtensionWithTab();
    const client = await connect("/client", { authorization: `Bearer ${daemon.token}` });
    const answered = next(client);
    client.send(JSON.stringify({ type: "request", id: 1, session: { id: "ctl-2", title: "T" }, method: "tabs.open", params: { url: "https://x.example" } }));
    await answered;
    const cookie = await signIn();
    const body = JSON.stringify({ session: "ctl-2" });

    expect((await http("/control/stop", { method: "POST", headers: { cookie }, body })).status).toBe(403);
    expect((await http("/control/stop", { method: "POST", headers: { cookie, "x-t3-browser": "1", origin: "https://evil.example" }, body })).status).toBe(403);

    const stopped = waitFor(ext, (m) => m.method === "session.stop" && m.session.id === "ctl-2");
    const res = await http("/control/stop", { method: "POST", headers: { cookie, "x-t3-browser": "1", origin: `http://127.0.0.1:${PORT}`, host: `127.0.0.1:${PORT}` }, body });
    expect(JSON.parse(res.body)).toEqual({ stopped: ["ctl-2"] });
    expect(await stopped).toBeDefined();
    client.close();
    ext.close();
  });
});

describe("remote client", () => {
  it("talks to a daemon by URL and token, without starting one of its own", async () => {
    const { BridgeClient } = await import("../../src/client");
    const client = new BridgeClient({ id: "far", title: "far" }, { base: `http://127.0.0.2:${PORT}`, token: daemon.token, remote: true });
    expect(client.remote).toBe(true);
    const status = await client.call<{ version: string; cdpUrl: string }>("daemon.status");
    expect(status.version).toBeTruthy();
    // The CDP URL the daemon makes points at 127.0.0.1; the remote agent needs its own route.
    expect(client.reachable(status.cdpUrl)).toMatch(new RegExp(`^ws://127\\.0\\.0\\.2:${PORT}/cdp/far\\?token=`));
    client.close();
  });

  it("explains an unreachable remote daemon instead of starting a local one", async () => {
    const { BridgeClient } = await import("../../src/client");
    const client = new BridgeClient({ id: "far", title: "far" }, { base: "http://127.0.0.1:1", token: daemon.token, remote: true });
    await expect(client.call("daemon.status")).rejects.toMatchObject({ code: "no_daemon", message: expect.stringMatching(/another machine/) });
  });
});

describe("hostile or broken peers", () => {
  /** Send raw bytes and wait for the server to answer or hang up. */
  function raw(bytes: string): Promise<string> {
    return new Promise((resolve) => {
      const sock = tcpConnect(PORT, "127.0.0.1", () => sock.write(bytes));
      let got = "";
      sock.on("data", (d) => (got += d));
      sock.on("close", () => resolve(got));
      sock.on("error", () => resolve(got));
      setTimeout(() => sock.destroy(), 1_000);
    });
  }

  it("survives a request line it cannot parse", async () => {
    expect(await raw("GET // HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 400/);
    await raw("GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    expect((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()).name).toBe("t3-browser");
  });

  it("ignores messages that are not objects", async () => {
    const client = await connect("/client", { authorization: `Bearer ${daemon.token}` });
    client.send("null");
    client.send("42");
    const status = next(client);
    client.send(JSON.stringify({ type: "request", id: 1, session: { id: "x", title: "x" }, method: "daemon.status" }));
    expect((await status).result.version).toBeTruthy();
    client.close();
  });

  it("keeps the extension it has while that one is alive", async () => {
    const real = await connect("/extension", { origin: `chrome-extension://${EXTENSION_ID}` });
    real.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, version: "real" }));
    await new Promise((r) => setTimeout(r, 50));
    // E.g. a process on the agent machine coming in through an SSH tunnel.
    const impostor = await connect("/extension", { origin: `chrome-extension://${EXTENSION_ID}` });
    const closed = new Promise<number>((resolve) => impostor.once("close", (code) => resolve(code)));
    expect(await closed).toBe(4001);
    const client = await connect("/client", { authorization: `Bearer ${daemon.token}` });
    const status = next(client);
    client.send(JSON.stringify({ type: "request", id: 1, session: { id: "x", title: "x" }, method: "daemon.status" }));
    expect((await status).result.extension.version).toBe("real");
    client.close();
    real.close();
  });

  it("lets a new extension take over from one that stopped answering", async () => {
    const stuck = await connect("/extension", { origin: `chrome-extension://${EXTENSION_ID}` });
    stuck.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, version: "stuck" }));
    await new Promise((r) => setTimeout(r, 50));
    stuck.pause(); // stops reading, so it never answers the daemon's ping
    const fresh = await connect("/extension", { origin: `chrome-extension://${EXTENSION_ID}` });
    fresh.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, version: "fresh" }));
    await new Promise((r) => setTimeout(r, 2_500));
    const client = await connect("/client", { authorization: `Bearer ${daemon.token}` });
    const status = next(client);
    client.send(JSON.stringify({ type: "request", id: 1, session: { id: "x", title: "x" }, method: "daemon.status" }));
    expect((await status).result.extension.version).toBe("fresh");
    client.close();
    fresh.close();
    stuck.terminate();
  });

  it("clears uploads left over from before a restart", () => {
    expect(existsSync(OLD_UPLOAD)).toBe(false);
  });
});

describe("CDP endpoints for remote agents", () => {
  it("describes the relay with the address the client used", async () => {
    const info = await (await fetch(`http://127.0.0.2:${PORT}/cdp/far/json/version?token=${daemon.token}`)).json();
    expect(info.webSocketDebuggerUrl).toMatch(new RegExp(`^ws://127\\.0\\.0\\.2:${PORT}/cdp/far\\?token=`));
  });

  it("rewrites daemon URLs for a daemon behind a proxy on the default port", async () => {
    const { BridgeClient } = await import("../../src/client");
    const client = new BridgeClient({ id: "far", title: "far" }, { base: "https://chrome.example.ts.net", token: daemon.token, remote: true });
    expect(client.reachable(`ws://127.0.0.1:47823/cdp/far?token=t`)).toBe("wss://chrome.example.ts.net/cdp/far?token=t");
  });

  it("refuses a remote URL without a token instead of sending its own", async () => {
    const { BridgeClient } = await import("../../src/client");
    const client = new BridgeClient({ id: "far", title: "far" }, { base: `http://127.0.0.2:${PORT}`, token: "", remote: true });
    await expect(client.call("daemon.status")).rejects.toMatchObject({ code: "no_token" });
  });
});
