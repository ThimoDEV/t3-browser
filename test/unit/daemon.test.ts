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
