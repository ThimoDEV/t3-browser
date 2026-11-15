// How the user tells agent threads apart in Chrome: a small number and a colour per thread,
// shared by the tab group, the in-page overlay (frame, pill, cursor) and the toolbar badge.
// Chrome tab groups only take a title and one of these 9 colours, and a page's tab icon cannot
// be borrowed (Chrome would remember it in history), so this is the whole vocabulary.
// Pure functions, so they are unit tested.

export type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

/** Handed out in this order: the first thread gets T3's purple. */
export const GROUP_COLORS: GroupColor[] = ["purple", "blue", "cyan", "green", "orange", "pink", "red", "yellow", "grey"];

/** Overlay colours matching Chrome's group colours (purple is T3's own). */
export const COLOR_HEX: Record<GroupColor, string> = {
  purple: "#7c5cff",
  blue: "#1a73e8",
  cyan: "#007b83",
  green: "#1e8e3e",
  orange: "#e8710a",
  pink: "#d01884",
  red: "#d93025",
  yellow: "#f9ab00",
  grey: "#5f6368",
};

/** Text colour on top of the thread colour (tag, badge): dark on the light ones, white otherwise. */
export function inkFor(color: GroupColor | undefined): string {
  return color === "yellow" || color === "orange" ? "#1f1f1f" : "#ffffff";
}

export interface Identity {
  num: number;
  color: GroupColor;
}

/**
 * The identity for a thread joining the threads that currently hold tabs: the lowest free
 * number, and the first colour nobody uses (or the least used one once all 9 are taken).
 * A thread keeps its existing identity when it does not clash with a live thread.
 */
export function allocateIdentity(current: Partial<Identity>, live: Array<Partial<Identity>>): Identity {
  const nums = new Set(live.map((l) => l.num).filter((n): n is number => typeof n === "number"));
  let num = current.num;
  if (!num || nums.has(num)) {
    num = 1;
    while (nums.has(num)) num++;
  }
  const used = new Map<GroupColor, number>();
  for (const l of live) if (l.color) used.set(l.color, (used.get(l.color) ?? 0) + 1);
  let color = current.color;
  if (!color || used.has(color)) {
    color = GROUP_COLORS.find((c) => !used.has(c)) ?? [...GROUP_COLORS].sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0))[0];
  }
  return { num, color };
}

/** "T3 #2 · Fix login": the brand, the thread's number, and its title (kept short for the chip). */
export function threadGroupTitle(num: number | undefined, title: string): string {
  const t = title.length > 28 ? title.slice(0, 27) + "…" : title;
  return num ? `T3 #${num} · ${t}` : `T3 · ${t}`;
}

export function isGroupColor(c: unknown): c is GroupColor {
  return typeof c === "string" && (GROUP_COLORS as string[]).includes(c);
}
