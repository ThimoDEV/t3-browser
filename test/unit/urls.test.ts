// Agents may only use web pages in the user's Chrome. These rules decide what "web page" means
// and how a bare address an agent types becomes a URL.
import { describe, expect, it } from "vitest";
import { isUsableTabUrl, isWebUrl, normalizeUrl, notWebPageMessage } from "../../extension/src/urls";

describe("isWebUrl", () => {
  it.each(["http://localhost:3000", "https://github.com/notifications", "http://127.0.0.1:8080/x?y=1", "http://[::1]:5173/"])(
    "allows %s",
    (url) => expect(isWebUrl(url)).toBe(true),
  );

  it.each([
    "chrome://settings",
    "chrome-extension://doaacelnfjdbbfhhkglnkdgboeajnlhk/popup.html",
    "chrome-untrusted://terminal/",
    "devtools://devtools/bundled/inspector.html",
    "edge://flags",
    "view-source:https://example.com",
    "file:///C:/Users/me/secrets.txt",
    "about:blank",
    "data:text/html,<h1>hi</h1>",
    "javascript:alert(1)",
    "https://chromewebstore.google.com/detail/abc",
    "https://chrome.google.com/webstore/detail/abc",
    "not a url",
  ])("refuses %s", (url) => expect(isWebUrl(url)).toBe(false));

  it("only treats the Web Store part of chrome.google.com as off limits", () => {
    expect(isWebUrl("https://chrome.google.com/intl/en/chrome/")).toBe(true);
  });
});

describe("isUsableTabUrl", () => {
  it("lets an agent keep working in its own tab while it is still blank", () => {
    expect(isUsableTabUrl("")).toBe(true);
    expect(isUsableTabUrl("about:blank")).toBe(true);
    expect(isUsableTabUrl("https://example.com")).toBe(true);
  });

  it("stops at browser pages the tab may have gone back to", () => {
    expect(isUsableTabUrl("chrome://newtab/")).toBe(false);
  });
});

describe("normalizeUrl", () => {
  it.each([
    ["localhost:3000", "http://localhost:3000"],
    ["localhost", "http://localhost"],
    ["app.localhost:5173/login", "http://app.localhost:5173/login"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["example.com", "https://example.com"],
    ["example.com:8443/path", "https://example.com:8443/path"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["  https://example.com  ", "https://example.com"],
  ])("%s -> %s", (input, expected) => expect(normalizeUrl(input)).toBe(expected));

  it("keeps real schemes so they can be refused", () => {
    expect(normalizeUrl("chrome://settings")).toBe("chrome://settings");
    expect(normalizeUrl("file:///etc/passwd")).toBe("file:///etc/passwd");
    expect(isWebUrl(normalizeUrl("chrome://settings"))).toBe(false);
  });
});

describe("notWebPageMessage", () => {
  it("names what was refused and tells the agent to hand over", () => {
    const m = notWebPageMessage("chrome://settings/passwords");
    expect(m).toContain("chrome://settings");
    expect(m).toMatch(/only works with web pages/);
    expect(m).toMatch(/Ask the user/);
  });
});
