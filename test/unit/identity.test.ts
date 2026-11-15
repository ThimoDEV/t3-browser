// Each agent thread gets a number and a colour so the user can tell its tabs apart: in the tab
// group, the overlay and the toolbar badge.
import { describe, expect, it } from "vitest";
import { allocateIdentity, COLOR_HEX, GROUP_COLORS, inkFor, threadGroupTitle } from "../../extension/src/identity";

describe("allocateIdentity", () => {
  it("gives the first thread #1 in T3 purple", () => {
    expect(allocateIdentity({}, [])).toEqual({ num: 1, color: "purple" });
  });

  it("gives the next thread the lowest free number and an unused colour", () => {
    const live = [
      { num: 1, color: "purple" as const },
      { num: 3, color: "blue" as const },
    ];
    expect(allocateIdentity({}, live)).toEqual({ num: 2, color: "cyan" });
  });

  it("keeps a thread's identity while it does not clash", () => {
    expect(allocateIdentity({ num: 4, color: "green" }, [{ num: 1, color: "purple" }])).toEqual({ num: 4, color: "green" });
  });

  it("re-picks whatever clashes with a live thread", () => {
    expect(allocateIdentity({ num: 1, color: "purple" }, [{ num: 1, color: "purple" }])).toEqual({ num: 2, color: "blue" });
  });

  it("shares the least used colour once all nine are taken", () => {
    const live = GROUP_COLORS.map((color, i) => ({ num: i + 1, color }));
    live.push({ num: 10, color: "purple" }, { num: 11, color: "blue" });
    expect(allocateIdentity({}, live)).toEqual({ num: 12, color: "cyan" });
  });
});

describe("threadGroupTitle", () => {
  it.each([
    [2, "Fix login", "T3 #2 · Fix login"],
    [undefined, "Fix login", "T3 · Fix login"],
    [1, "Plan the team offsite in Lisbon for March", "T3 #1 · Plan the team offsite in Li…"],
  ])("#%s %s -> %s", (num, title, expected) => expect(threadGroupTitle(num, title)).toBe(expected));
});

describe("COLOR_HEX", () => {
  it("has an overlay colour for every group colour", () => {
    for (const c of GROUP_COLORS) expect(COLOR_HEX[c]).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("inkFor", () => {
  it.each([
    ["yellow", "#1f1f1f"],
    ["orange", "#1f1f1f"],
    ["purple", "#ffffff"],
    ["blue", "#ffffff"],
    [undefined, "#ffffff"],
  ] as const)("text on %s is %s", (color, ink) => expect(inkFor(color)).toBe(ink));
});
