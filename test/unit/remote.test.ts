// Agents on other machines reach the daemon on the Chrome machine. These are the rules for
// where the daemon may listen, which daemon a process uses, and how uploads cross over.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

process.env.T3_BROWSER_HOME = mkdtempSync(join(tmpdir(), "t3b-remote-"));
process.env.T3_BROWSER_PORT = "47999";
const { HOME, REMOTE_FILE } = await import("../../src/paths");
const remote = await import("../../src/remote");

describe("checkListenAddress", () => {
  it.each(["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.20", "100.64.0.1", "100.101.102.103", "100.127.255.254", "::1", "fd7a:115c:a1e0::1"])(
    "allows the private address %s",
    (addr) => expect(remote.checkListenAddress(addr)).toBeUndefined(),
  );

  it.each([
    ["0.0.0.0", /every interface/],
    ["::", /every interface/],
    ["8.8.8.8", /public/],
    ["172.32.0.1", /public/],
    ["100.63.255.255", /public/],
    ["100.128.0.1", /public/],
    ["2001:4860:4860::8888", /not a private IPv6/],
    ["my-laptop.tailnet.ts.net", /not an IP address/],
  ])("refuses %s", (addr, why) => expect(remote.checkListenAddress(addr)).toMatch(why));
});

describe("isLoopbackAddress", () => {
  it.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["100.101.102.103", false],
    ["::ffff:192.168.1.2", false],
    [undefined, false],
  ])("%s -> %s", (addr, expected) => expect(remote.isLoopbackAddress(addr)).toBe(expected));
});

describe("normalizeBase", () => {
  it.each([
    ["ws://100.101.102.103:47823", "http://100.101.102.103:47823"],
    ["wss://chrome.example.ts.net/", "https://chrome.example.ts.net"],
    ["http://127.0.0.1:47823/control?token=x", "http://127.0.0.1:47823"],
  ])("%s -> %s", (input, expected) => expect(remote.normalizeBase(input)).toBe(expected));

  it("rejects other schemes", () => {
    expect(() => remote.normalizeBase("file:///etc/passwd")).toThrow(/Unsupported URL/);
  });
});

describe("bridgeEndpoint", () => {
  afterEach(() => {
    delete process.env.T3_BROWSER_URL;
    delete process.env.T3_BROWSER_TOKEN;
    remote.removeRemoteLink();
  });

  it("uses the local daemon when nothing is linked", () => {
    expect(remote.bridgeEndpoint()).toMatchObject({ base: "http://127.0.0.1:47999", remote: false });
  });

  it("uses a saved link", () => {
    remote.writeRemoteLink("ws://100.101.102.103:47823", "a".repeat(64));
    expect(remote.bridgeEndpoint()).toEqual({ base: "http://100.101.102.103:47823", token: "a".repeat(64), remote: true });
    expect(JSON.parse(readFileSync(REMOTE_FILE, "utf8")).token).toBe("a".repeat(64));
  });

  it("lets T3_BROWSER_URL and T3_BROWSER_TOKEN override a saved link", () => {
    remote.writeRemoteLink("ws://100.101.102.103:47823", "a".repeat(64));
    process.env.T3_BROWSER_URL = "ws://127.0.0.1:50000";
    process.env.T3_BROWSER_TOKEN = "b".repeat(64);
    expect(remote.bridgeEndpoint()).toEqual({ base: "http://127.0.0.1:50000", token: "b".repeat(64), remote: true });
  });

  it("never sends this machine's own token to a remote URL", () => {
    process.env.T3_BROWSER_URL = "ws://100.101.102.103:47823";
    const endpoint = remote.bridgeEndpoint();
    expect(endpoint.remote).toBe(true);
    expect(endpoint.token).toBe("");
  });

  it("ignores a broken link file", () => {
    writeFileSync(REMOTE_FILE, "{not json");
    expect(remote.bridgeEndpoint().remote).toBe(false);
  });
});

describe("materializeUploads", () => {
  it("writes the files under the daemon's home, keeping their names", () => {
    const [path] = remote.materializeUploads([{ name: "cv.pdf", data: Buffer.from("%PDF-1.7 hello").toString("base64") }]);
    expect(basename(path)).toBe("cv.pdf");
    expect(path.startsWith(join(HOME, "uploads"))).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("%PDF-1.7 hello");
  });

  it("never lets a file name escape its folder", () => {
    const [path] = remote.materializeUploads([{ name: "../../../.ssh/authorized_keys", data: "" }]);
    expect(basename(path)).toBe("authorized_keys");
    expect(path.startsWith(join(HOME, "uploads"))).toBe(true);
    expect(existsSync(join(HOME, ".ssh"))).toBe(false);
  });

  it("keeps two files with the same name apart", () => {
    const [a, b] = remote.materializeUploads([
      { name: "photo.jpg", data: Buffer.from("first").toString("base64") },
      { name: "photo.jpg", data: Buffer.from("second").toString("base64") },
    ]);
    expect([basename(a), basename(b)]).toEqual(["photo.jpg", "photo.jpg"]);
    expect([readFileSync(a, "utf8"), readFileSync(b, "utf8")]).toEqual(["first", "second"]);
  });

  it("refuses more than the size limit", () => {
    const tooBig = "A".repeat(Math.ceil(((remote.MAX_INLINE_UPLOAD_BYTES + 1) * 4) / 3));
    expect(() => remote.materializeUploads([{ name: "big.bin", data: tooBig }])).toThrow(/limited to 40MB/);
  });
});
