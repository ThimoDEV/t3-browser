// What the agent reads when the user hands a tab back: which tab, where it is now, and the note.
import { describe, expect, it } from "vitest";
import { handbackMessage, NOTE_MAX } from "../../extension/src/handback";

describe("handbackMessage", () => {
  it("names the tab and page, then the user's note", () => {
    expect(handbackMessage(812, "Dashboard", "https://github.com/settings/profile", "  Logged in. Use the second account.  ")).toBe(
      "[T3 Browser] Handing tab 812 (“Dashboard” at https://github.com/settings/profile) back to you.\n\nLogged in. Use the second account.",
    );
  });

  it("without a note, tells the agent to carry on", () => {
    expect(handbackMessage(5, "Inbox", "https://mail.example/", "")).toBe("[T3 Browser] Handing tab 5 (“Inbox” at https://mail.example) back to you. Carry on where you left off.");
  });

  it("leaves out the URL's query and fragment, which may carry a login code", () => {
    const text = handbackMessage(5, "Done", "https://app.example/callback?code=SECRET&state=x#token=ALSO", "");
    expect(text).toContain("https://app.example/callback)");
    expect(text).not.toMatch(/SECRET|ALSO|state=/);
  });

  it("still names the tab when Chrome no longer knows its title or address", () => {
    expect(handbackMessage(9, undefined, undefined, "ok")).toBe("[T3 Browser] Handing tab 9 back to you.\n\nok");
  });

  it("caps a very long note", () => {
    const text = handbackMessage(1, "T", "https://x.example/", "a".repeat(NOTE_MAX + 500));
    expect(text.endsWith("a".repeat(NOTE_MAX))).toBe(true);
    expect(text).not.toContain("a".repeat(NOTE_MAX + 1));
  });
});
