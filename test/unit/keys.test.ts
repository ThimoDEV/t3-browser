import { describe, expect, it } from "vitest";
import { parseKey } from "../../extension/src/keys";

describe("parseKey", () => {
  it("named keys", () => {
    expect(parseKey("Enter")).toMatchObject({ key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 });
    expect(parseKey("arrowdown")).toMatchObject({ key: "ArrowDown", keyCode: 40 });
    expect(parseKey("F5")).toMatchObject({ key: "F5", keyCode: 116 });
  });

  it("characters", () => {
    expect(parseKey("a")).toMatchObject({ key: "a", code: "KeyA", keyCode: 65, text: "a" });
    expect(parseKey("Shift+a")).toMatchObject({ key: "A", text: "A", modifiers: 8 });
    expect(parseKey("7")).toMatchObject({ code: "Digit7", keyCode: 55 });
  });

  it("chords run shortcuts instead of typing", () => {
    const k = parseKey("Control+a");
    expect(k.modifiers).toBe(2);
    expect(k.text).toBeUndefined();
    expect(parseKey("Control+Shift+Tab").modifiers).toBe(10);
  });

  it("plus as a key", () => {
    expect(parseKey("+")).toMatchObject({ key: "+", text: "+" });
    expect(parseKey("Control++")).toMatchObject({ key: "+", modifiers: 2 });
  });

  it("rejects nonsense", () => {
    expect(() => parseKey("Hyper+a")).toThrow(/modifier/);
    expect(() => parseKey("NotAKey")).toThrow(/Unknown key/);
  });
});
