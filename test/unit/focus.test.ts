// A popup opened by an agent's background tab must not take over the user's screen, but the
// user's own later choices (and the agent's screenshots) must never be undone.
import { describe, expect, it } from "vitest";
import { tabBefore, tabToRestore, type NewTabActivation } from "../../extension/src/focus";

const USER = 10;
const AGENT = 20;
const POPUP = 30;
const popupJumpedInFront: NewTabActivation = {
  tabId: POPUP,
  source: AGENT,
  sourceIsAgentTab: true,
  ageMs: 120,
  before: USER,
  ownActivation: false,
  alreadyDecided: false,
};

describe("tabToRestore", () => {
  it("puts the user's tab back when an agent's background tab opens a popup", () => {
    expect(tabToRestore(popupJumpedInFront)).toBe(USER);
  });

  it.each([
    ["the user clicks the new tab later on", { ageMs: 1_500 }],
    ["the extension brought it forward to screenshot it", { ownActivation: true }],
    ["it was already judged once", { alreadyDecided: true }],
    ["the user's own page opened it", { sourceIsAgentTab: false }],
    ["the agent's tab was in front, so the user is watching", { before: AGENT }],
    ["nothing is known about what was in front", { before: undefined }],
  ])("leaves things alone when %s", (_why, change) => {
    expect(tabToRestore({ ...popupJumpedInFront, ...change })).toBeUndefined();
  });
});

describe("tabBefore", () => {
  it("is the tab in front when the new tab is not in front yet", () => {
    expect(tabBefore(POPUP, USER, 99)).toBe(USER);
  });

  it("is the one before that when the new tab's activation was reported first", () => {
    expect(tabBefore(POPUP, POPUP, USER)).toBe(USER);
  });
});
