// Per-thread state: which tabs belong to which agent thread, its tab group, and
// interruptions. Persisted in chrome.storage.session so a service-worker restart does not
// forget which tabs an agent owns.
//
// There is no per-site approval: if the extension is installed and connected, agents may
// use any web page (http/https) in their own tab group. Browser pages are refused outright
// (see urls.ts). The user can still press Esc or Stop at any time to take control back.

import type { SessionInfo } from "../../src/protocol";
import { isUsableTabUrl, isWebUrl, notWebPageMessage } from "./urls";

export interface Session {
  id: string;
  title: string;
  /** Set by browser_name_session; from then on the default title from the MCP env is ignored. */
  named?: boolean;
  groupId?: number;
  tabIds: number[];
  /** The user has allowed this thread to list all their open tabs. */
  mayListAllTabs?: boolean;
  /** Set by Esc / Stop; reported to the agent once, then cleared. */
  interrupted?: string;
  createdAt: number;
}

export interface Settings {
  port: number;
}

export const DEFAULT_SETTINGS: Settings = { port: 47823 };

type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";
const GROUP_COLORS: GroupColor[] = ["purple", "blue", "cyan", "green", "orange", "pink", "yellow", "red"];

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
  return { port: typeof stored.port === "number" ? stored.port : DEFAULT_SETTINGS.port };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  // Only known keys are written, which also drops settings from older versions
  // (the site allow-list and "trusted" mode).
  const next: Settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: { port: next.port } });
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
  const t = s.title.length > 28 ? s.title.slice(0, 27) + "…" : s.title;
  return `T3 · ${t}`;
}

/** Same thread, same colour, across service-worker restarts and new groups. */
function groupColor(s: Session): GroupColor {
  let h = 0;
  for (const ch of s.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

async function liveGroup(s: Session): Promise<chrome.tabGroups.TabGroup | undefined> {
  if (s.groupId === undefined) return undefined;
  const group = await chrome.tabGroups.get(s.groupId).catch(() => undefined);
  if (!group) s.groupId = undefined;
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
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
  if (win?.id !== undefined && win.type === "normal") return { windowId: win.id };
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

/** Put a tab into the session's tab group, creating the group (named after the thread) if needed. */
export async function addTab(s: Session, tabId: number): Promise<void> {
  if (!s.tabIds.includes(tabId)) s.tabIds.push(tabId);
  const tab = await chrome.tabs.get(tabId);
  const group = await liveGroup(s);
  if (group && group.windowId === tab.windowId) {
    if (tab.groupId !== group.id) await retryWhileDragging(() => chrome.tabs.group({ groupId: group.id, tabIds: [tabId] }));
  } else {
    // First tab, the user closed the group, or the tab lives in another window.
    s.groupId = await retryWhileDragging(() => chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } }));
    await chrome.tabGroups.update(s.groupId, {
      title: groupTitle(s),
      color: groupColor(s) as `${chrome.tabGroups.Color}`,
      collapsed: false,
    });
  }
  await save();
}

export async function removeTab(tabId: number): Promise<Session | undefined> {
  await load();
  for (const s of sessions.values()) {
    const i = s.tabIds.indexOf(tabId);
    if (i >= 0) {
      s.tabIds.splice(i, 1);
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

// ---------------------------------------------------------------------------------------
// Confirmations that remain: listing all the user's tabs, taking over a tab the user opened,
// and uploading local files. (Sites themselves need no approval.)

export interface ApprovalRequest {
  id: string;
  sessionTitle: string;
  kind: "tabs" | "upload" | "claim";
  origin?: string;
  detail?: string;
}

type Decision = "once" | "deny" | "timeout";
const pendingApprovals = new Map<string, { req: ApprovalRequest; resolve: (d: Decision) => void; windowId?: number }>();
const approvalDedup = new Map<string, Promise<Decision>>();

/**
 * How long a prompt waits for the user. Must stay well below the daemon's request timeout
 * (120s) so the agent gets a clear answer instead of "Timed out waiting for Chrome".
 */
const APPROVAL_TIMEOUT_MS = 90_000;

export function getApproval(id: string): ApprovalRequest | undefined {
  return pendingApprovals.get(id)?.req;
}

export function resolveApproval(id: string, decision: Decision): void {
  const p = pendingApprovals.get(id);
  if (!p) return;
  pendingApprovals.delete(id);
  p.resolve(decision);
  if (p.windowId !== undefined) chrome.windows.remove(p.windowId).catch(() => {});
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, p] of pendingApprovals) if (p.windowId === windowId) resolveApproval(id, "deny");
});

async function askUser(req: Omit<ApprovalRequest, "id">, dedupKey: string): Promise<Decision> {
  const existing = approvalDedup.get(dedupKey);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const promise = new Promise<Decision>((resolve) => {
    pendingApprovals.set(id, { req: { ...req, id }, resolve });
  });
  approvalDedup.set(dedupKey, promise);
  promise.finally(() => approvalDedup.delete(dedupKey));
  const timeout = setTimeout(() => resolveApproval(id, "timeout"), APPROVAL_TIMEOUT_MS);
  promise.finally(() => clearTimeout(timeout));

  const last = await chrome.windows.getLastFocused().catch(() => undefined);
  const width = 440;
  const height = 330;
  const base = { url: chrome.runtime.getURL(`approve.html?id=${id}`), type: "popup" as const, width, height, focused: true };
  // Top-right of the user's current window; Chrome rejects positions that end up off-screen
  // (multi-monitor setups, headless), so fall back to its default placement.
  const win = await chrome.windows
    .create({
      ...base,
      left: last?.left !== undefined && last.width ? Math.max(0, last.left + last.width - width - 24) : undefined,
      top: last?.top !== undefined ? Math.max(0, last.top + 80) : undefined,
    })
    .catch(() => chrome.windows.create(base).catch(() => undefined));
  if (win?.id === undefined) {
    resolveApproval(id, "deny");
    return promise;
  }
  const p = pendingApprovals.get(id);
  if (p) p.windowId = win.id;
  // When another app has focus (e.g. T3 Code), Windows will not raise the prompt; at least
  // flash it in the taskbar.
  chrome.windows.update(win.id, { focused: true, drawAttention: true }).catch(() => {});
  return promise;
}

function refusal(d: Decision, what: string): ActionError | undefined {
  if (d === "timeout") {
    return new ActionError(
      `The user did not answer the T3 Browser prompt (${what}) within ${APPROVAL_TIMEOUT_MS / 1000}s. Ask the user in chat, then try again.`,
      "no_answer",
    );
  }
  if (d === "deny") return new ActionError(`The user said no (${what}).`, "denied");
  return undefined;
}

export async function ensureMayListTabs(s: Session): Promise<void> {
  if (s.mayListAllTabs) return;
  const e = refusal(await askUser({ sessionTitle: s.title, kind: "tabs" }, `tabs:${s.id}`), "seeing their open tabs");
  if (e) throw e;
  s.mayListAllTabs = true;
  await save();
}

export async function ensureMayClaim(s: Session, tab: chrome.tabs.Tab): Promise<void> {
  const d = await askUser(
    { sessionTitle: s.title, kind: "claim", origin: new URL(tab.url!).origin, detail: tab.title },
    `claim:${s.id}:${tab.id}`,
  );
  const e = refusal(d, "handing over that tab");
  if (e) throw e;
}

export async function ensureMayUpload(s: Session, origin: string, files: string[]): Promise<void> {
  const d = await askUser({ sessionTitle: s.title, kind: "upload", origin, detail: files.join("\n") }, `upload:${s.id}:${files.join("|")}`);
  const e = refusal(d, "uploading those files");
  if (e) throw e;
}
