// Per-thread state: which tabs belong to which agent thread, its tab group, and
// interruptions. Persisted in chrome.storage.session so a service-worker restart does not
// forget which tabs an agent owns.
//
// There are no permission prompts: if the extension is installed and connected, agents may
// use any web page (http/https) in their own tab group, see the user's web tabs and take one
// over. Browser pages are refused outright (see urls.ts). The user can press Esc or Stop at
// any time to take control back.

import type { SessionInfo } from "../../src/protocol";
import { allocateIdentity, COLOR_HEX, inkFor, isGroupColor, threadGroupTitle, type GroupColor } from "./identity";
import { createKeyedQueue } from "./serial";
import { isUsableTabUrl, isWebUrl, notWebPageMessage } from "./urls";

export interface Session {
  id: string;
  title: string;
  /** Set by browser_name_session; from then on the default title from the MCP env is ignored. */
  named?: boolean;
  /** The thread in T3 Code (web link), when the MCP server could read it. */
  link?: string;
  /** Number and colour that identify this thread in Chrome (group, overlay, badge); see identity.ts. */
  num?: number;
  color?: GroupColor;
  groupId?: number;
  tabIds: number[];
  /** Set by Esc / Stop; reported to the agent once, then cleared. */
  interrupted?: string;
  createdAt: number;
}

export interface Settings {
  port: number;
  /** Detach the debugger from tabs the agent has not used for this long (ms), so Chrome's
   * "started debugging this browser" bar goes away while the agent is idle. */
  idleDetachMs: number;
  /** "always": a thread's tabs live in its tab group from the first tab. "multi": a thread with
   * one tab leaves it ungrouped (quick tasks stay out of the way); the group appears with its
   * second tab. */
  groupMode: "always" | "multi";
}

export const DEFAULT_SETTINGS: Settings = { port: 47823, idleDetachMs: 60_000, groupMode: "always" };

export class ActionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

let sessions = new Map<string, Session>();
let loaded: Promise<void> | null = null;

function load(): Promise<void> {
  loaded ??= chrome.storage.session.get("sessions").then((v) => {
    const list = (v.sessions as Session[] | undefined) ?? [];
    sessions = new Map(list.map((s) => [s.id, s]));
  });
  return loaded;
}

async function save(): Promise<void> {
  await chrome.storage.session.set({ sessions: [...sessions.values()] });
}

export async function getSettings(): Promise<Settings> {
  const v = await chrome.storage.local.get("settings");
  const stored = (v.settings ?? {}) as Partial<Settings>;
  return {
    port: typeof stored.port === "number" ? stored.port : DEFAULT_SETTINGS.port,
    idleDetachMs: typeof stored.idleDetachMs === "number" && stored.idleDetachMs >= 1_000 ? stored.idleDetachMs : DEFAULT_SETTINGS.idleDetachMs,
    groupMode: stored.groupMode === "multi" ? "multi" : "always",
  };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  // Only known keys are written, which also drops settings from older versions
  // (the site allow-list and "trusted" mode).
  const next: Settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: { port: next.port, idleDetachMs: next.idleDetachMs, groupMode: next.groupMode } });
  return next;
}

export async function allSessions(): Promise<Session[]> {
  await load();
  return [...sessions.values()];
}

export async function getSession(info: SessionInfo): Promise<Session> {
  await load();
  let s = sessions.get(info.id);
  if (!s) {
    s = { id: info.id, title: info.title || "Agent", tabIds: [], createdAt: Date.now() };
    sessions.set(s.id, s);
    await save();
  } else if (!s.named && info.title && info.title !== info.id && info.title !== s.title) {
    await renameSession(s, info.title);
  }
  if (info.link && info.link !== s.link && isWebUrl(info.link)) {
    s.link = info.link;
    await save();
  }
  return s;
}

export async function renameSession(s: Session, title: string): Promise<void> {
  s.title = title.slice(0, 60);
  await save();
  if (s.groupId !== undefined) await chrome.tabGroups.update(s.groupId, { title: groupTitle(s) }).catch(() => {});
}

export async function sessionForTab(tabId: number): Promise<Session | undefined> {
  await load();
  for (const s of sessions.values()) if (s.tabIds.includes(tabId)) return s;
  return undefined;
}

export async function persist(): Promise<void> {
  await save();
}

export async function dropSession(id: string): Promise<void> {
  await load();
  sessions.delete(id);
  await save();
}

export function groupTitle(s: Session): string {
  return threadGroupTitle(s.num, s.title);
}

/** The colour this thread shows in the overlay and badge (T3 purple until it has one). */
export function threadColorHex(s: Session): string {
  return COLOR_HEX[s.color ?? "purple"];
}

export function threadInk(s: Session): string {
  return inkFor(s.color);
}

/**
 * Give the thread a number and colour that no other thread holding tabs is using. Only when it
 * has none yet, or is (re)starting with its first tab: a thread that already shows its identity
 * keeps it (e.g. after the user gave another group the same colour on purpose).
 */
function ensureIdentity(s: Session): void {
  if (s.num && s.color && s.tabIds.length > 1) return;
  const live = [...sessions.values()].filter((o) => o.id !== s.id && o.tabIds.length > 0);
  const next = allocateIdentity({ num: s.num, color: s.color }, live);
  s.num = next.num;
  s.color = next.color;
}

async function liveGroup(s: Session): Promise<chrome.tabGroups.TabGroup | undefined> {
  if (s.groupId === undefined) return undefined;
  const group = await chrome.tabGroups.get(s.groupId).catch(() => undefined);
  if (!group) s.groupId = undefined;
  // The user recoloured the group: that is now the thread's colour everywhere.
  else if (isGroupColor(group.color) && group.color !== s.color) s.color = group.color;
  return group;
}

/**
 * Where a new tab for this thread goes: right after the last tab of the thread's group, in
 * the group's window, so it appears inside the group instead of flashing at the end of the
 * strip. Without a group: the window the user last used.
 */
export async function placeForNewTab(s: Session): Promise<{ windowId: number; index?: number }> {
  const group = await liveGroup(s);
  if (group) {
    const inGroup = await chrome.tabs.query({ groupId: group.id });
    if (inGroup.length) return { windowId: group.windowId, index: Math.max(...inGroup.map((t) => t.index)) + 1 };
  }
  // No group yet: right next to the tab the user is on, like a link they opened themselves.
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
  if (win?.id !== undefined && win.type === "normal") {
    const [active] = await chrome.tabs.query({ active: true, windowId: win.id });
    return { windowId: win.id, ...(active ? { index: active.index + 1 } : {}) };
  }
  const all = await chrome.windows.getAll({ windowTypes: ["normal"] });
  if (all[0]?.id !== undefined) return { windowId: all[0].id };
  const created = await chrome.windows.create({ focused: false });
  return { windowId: created!.id! };
}

/** Chrome refuses tab edits while the user drags a tab; that lasts a moment. */
async function retryWhileDragging<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= 10 || !/cannot be edited right now/i.test(String((err as Error).message ?? err))) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** One grouping at a time per thread: two tabs opened at once must not each create a group. */
const withGroupLock = createKeyedQueue();

/**
 * Add a tab to the thread: give the thread its number and colour, mark the tab, and put it in
 * the thread's tab group (created on demand, named after the thread). With groupMode "multi" a
 * thread's only tab stays where it is; the group appears once it has a second tab.
 */
export async function addTab(s: Session, tabId: number, opts: { opened?: boolean } = {}): Promise<void> {
  if (!s.tabIds.includes(tabId)) s.tabIds.push(tabId);
  ensureIdentity(s);
  await markTab(s, tabId);
  await withGroupLock(s.id, async () => {
    const tab = await chrome.tabs.get(tabId);
    const group = await liveGroup(s);
    if (group && group.windowId === tab.windowId) {
      if (tab.groupId !== group.id) await retryWhileDragging(() => chrome.tabs.group({ groupId: group.id, tabIds: [tabId] }));
      return;
    }
    const { groupMode } = await getSettings();
    if (groupMode === "multi" && !group && s.tabIds.length < 2) {
      // Opened next to the user's tab, it may have landed inside someone else's group.
      if (opts.opened && tab.groupId !== -1) await retryWhileDragging(() => chrome.tabs.ungroup(tabId)).catch(() => {});
      return;
    }
    // First (or second, in "multi") tab, the user closed the group, or another window: group
    // every tab of the thread that lives in this window.
    const here = (await Promise.all(s.tabIds.map((id) => chrome.tabs.get(id).catch(() => undefined)))).filter((t) => t && t.windowId === tab.windowId).map((t) => t!.id!);
    s.groupId = await retryWhileDragging(() => chrome.tabs.group({ tabIds: here as [number, ...number[]], createProperties: { windowId: tab.windowId } }));
    await chrome.tabGroups.update(s.groupId, {
      title: groupTitle(s),
      color: (s.color ?? "purple") as `${chrome.tabGroups.Color}`,
      collapsed: false,
    });
  });
  await save();
}

/** The toolbar badge on the thread's tabs: its number, in its colour. */
export async function markTab(s: Session, tabId: number): Promise<void> {
  if (!s.num) return;
  await chrome.action.setBadgeText({ tabId, text: `#${s.num}` }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: threadColorHex(s) }).catch(() => {});
  await chrome.action.setBadgeTextColor?.({ tabId, color: threadInk(s) }).catch(() => {});
}

/** The user recoloured a thread's group in Chrome: that is the thread's colour everywhere now. */
export async function adoptGroupColor(groupId: number, color: string): Promise<Session | undefined> {
  await load();
  const s = [...sessions.values()].find((x) => x.groupId === groupId);
  if (!s || !isGroupColor(color) || color === s.color) return undefined;
  s.color = color;
  await save();
  // Released meanwhile (its group just went grey on the way out): leave its tabs alone.
  if (sessions.get(s.id) !== s || s.groupId !== groupId) return undefined;
  for (const tabId of s.tabIds) await markTab(s, tabId);
  return s;
}

export async function unmarkTab(tabId: number): Promise<void> {
  // null: back to the extension's global badge for this tab.
  await chrome.action.setBadgeText({ tabId, text: null as unknown as string }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#6b7280" }).catch(() => {});
  await chrome.action.setBadgeTextColor?.({ tabId, color: "#ffffff" }).catch(() => {});
}

export async function removeTab(tabId: number): Promise<Session | undefined> {
  await load();
  for (const s of sessions.values()) {
    const i = s.tabIds.indexOf(tabId);
    if (i >= 0) {
      s.tabIds.splice(i, 1);
      await unmarkTab(tabId);
      await save();
      return s;
    }
  }
  return undefined;
}

export function assertOwnsTab(s: Session, tabId: number): void {
  if (!s.tabIds.includes(tabId)) {
    throw new ActionError(
      `Tab ${tabId} is not controlled by this thread. Use browser_tabs to list your tabs, or browser_claim_tab to ask the user for one of theirs.`,
      "not_owned",
    );
  }
}

/** Interrupt handling: the next call from the agent learns about it, exactly once. */
export async function takeInterrupt(s: Session): Promise<void> {
  if (!s.interrupted) return;
  const why = s.interrupted;
  s.interrupted = undefined;
  await save();
  throw new ActionError(
    `The user took back control of the browser (${why}). Stop and ask the user how to continue before using the browser again.`,
    "interrupted",
  );
}

export async function markInterrupted(s: Session, reason: string): Promise<void> {
  s.interrupted = reason;
  await save();
}

// ---------------------------------------------------------------------------------------
// Web pages only

/** Throws unless `url` is a web page an agent may open or navigate to. */
export function assertWebUrl(url: string): void {
  if (!isWebUrl(url) && url !== "about:blank") throw new ActionError(notWebPageMessage(url), "restricted");
}

/** Throws unless an owned tab currently shows a web page (or is still blank). */
export function assertUsableTab(tab: chrome.tabs.Tab): void {
  const url = tab.url || tab.pendingUrl || "";
  if (!isUsableTabUrl(url)) throw new ActionError(notWebPageMessage(url), "restricted");
}
