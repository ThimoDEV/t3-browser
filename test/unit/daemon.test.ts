// The daemon is the security boundary: only the pinned extension may connect as the browser,
// and only local processes holding the token (and no web Origin) may drive it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const PORT = 48100 + Math.floor(Math.random() * 500);
process.env.T3_BROWSER_HOME = mkdtempSync(join(tmpdir(), "t3b-unit-"));
process.env.T3_BROWSER_PORT = String(PORT);
process.env.T3_BROWSER_RELEASE_AFTER_MS = "300";

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

function next(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
}

beforeAll(async () => {
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
    expect(await waitFor(ext, releaseFor("gone-2"), 700)).toBeUndefined();
    const release = waitFor(ext, releaseFor("gone-2"));
    b.close();
    expect(await release).toBeDefined();
    ext.close();
  });

  it("does not release a thread that reconnects in time", async () => {
    const ext = await fakeExtension();
    (await client("gone-3")).close();
    const back = await client("gone-3", "status");
    expect(await waitFor(ext, releaseFor("gone-3"), 700)).toBeUndefined();
    back.close();
    expect(await waitFor(ext, releaseFor("gone-3"))).toBeDefined();
    ext.close();
  });

  it("does not release again after the agent called browser_done", async () => {
    const ext = await fakeExtension();
    const c = await client("gone-4");
    await request(c, "gone-4", "session.release", { keepTabIds: [] });
    c.close();
    expect(await waitFor(ext, (m) => releaseFor("gone-4")(m) && m.params?.keepGroup, 700)).toBeUndefined();
    ext.close();
  });

  it("retries a release that could not reach Chrome once the extension is back", async () => {
    const ext = await fakeExtension();
    const c = await client("gone-5");
    ext.close();
    await new Promise((r) => setTimeout(r, 100));
    c.close();
    // The release timer fires while Chrome is away, so nothing can be released yet.
    await new Promise((r) => setTimeout(r, 600));
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
    c.close();
    await new Promise((r) => setTimeout(r, 100));
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
