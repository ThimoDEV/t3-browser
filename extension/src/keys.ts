// Key descriptions for CDP Input.dispatchKeyEvent. Accepts Playwright-style chords: "Control+a".

export interface KeyEvent {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  modifiers: number;
}

const MODIFIERS: Record<string, number> = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

const NAMED: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

export function parseKey(chord: string): KeyEvent {
  // "+" itself is a valid key ("Control++"), so split carefully.
  const parts = chord === "+" ? ["+"] : chord.split(/\+(?!$)/);
  const keyName = parts.pop()!;
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIERS[m.toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown modifier "${m}" in "${chord}"`);
    modifiers |= bit;
  }

  const named = NAMED[keyName.toLowerCase()];
  let ev: KeyEvent;
  if (named) {
    ev = { ...named, modifiers };
  } else if ([...keyName].length === 1) {
    const ch = keyName;
    const upper = ch.toUpperCase();
    const isLetter = /[a-z]/i.test(ch);
    const isDigit = /[0-9]/.test(ch);
    const shifted = (modifiers & 8) !== 0;
    const key = isLetter && shifted ? upper : ch;
    ev = {
      key,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${ch}` : "",
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: key,
      modifiers,
    };
  } else {
    throw new Error(`Unknown key "${keyName}". Use names like Enter, Tab, Escape, ArrowDown, or a single character.`);
  }
  // With Ctrl/Alt/Meta held the browser should run the shortcut, not insert text.
  if (modifiers & (1 | 2 | 4)) delete ev.text;
  return ev;
}
