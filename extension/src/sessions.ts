// Per-thread state: which tabs belong to which agent thread, its tab group, site approvals
// and interruptions. Persisted in chrome.storage.session so a service-worker restart does
// not forget which tabs an agent owns.

import type { SessionInfo } from "../../src/protocol";

export interface Session {
  id: string;
  title: string;
  groupId?: number;
  tabIds: number[];
  /** Origins approved "for this thread only". */
  allowedOrigins: string[];
  /** The user has allowed this thread to list all their open tabs. */
  mayListAllTabs?: boolean;
  /** Set by Esc / Stop; reported to the agent once, then cleared. */
  interrupted?: string;
  createdAt: number;
}

export interface Settings {
  /** "ask": approve each new site. "trusted": never ask (still blocks restricted pages). */
  approvalMode: "ask" | "trusted";
  /** Sites approved for every thread. */
  alwaysAllowed: string[];
  port: number;
}

export const DEFAULT_SETTINGS: Settings = { approvalMode: "ask", alwaysAllowed: [], port: 47823 };

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
  return { ...DEFAULT_SETTINGS, ...(v.settings as Partial<Settings> | undefined) };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
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
    s = { id: info.id, title: info.title || "Agent", tabIds: [], allowedOrigins: [], createdAt: Date.now() };
    sessions.set(s.id, s);
    await save();
  } else if (info.title && info.title !== info.id && info.title !== s.title) {
    s.title = info.title;
    await save();
    if (s.groupId !== undefined) await chrome.tabGroups.update(s.groupId, { title: groupTitle(s) }).catch(() => {});
  }
  return s;
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

function groupTitle(s: Session): string {
  const t = s.title.length > 28 ? s.title.slice(0, 27) + "…" : s.title;
  return `T3 · ${t}`;
}

/** Put a tab into the session's tab group, creating the group if needed. */
export async function addTab(s: Session, tabId: number): Promise<void> {
  if (!s.tabIds.includes(tabId)) s.tabIds.push(tabId);
  const tab = await chrome.tabs.get(tabId);
  let groupOk = false;
  if (s.groupId !== undefined) {
    try {
      const group = await chrome.tabGroups.get(s.groupId);
      if (group.windowId === tab.windowId) {
        await chrome.tabs.group({ groupId: s.groupId, tabIds: [tabId] });
        groupOk = true;
      }
    } catch {
      s.groupId = undefined;
    }
  }
  if (!groupOk) {
    s.groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    const index = [...sessions.keys()].indexOf(s.id);
    await chrome.tabGroups.update(s.groupId, {
      title: groupTitle(s),
      color: GROUP_COLORS[Math.max(0, index) % GROUP_COLORS.length] as `${chrome.tabGroups.Color}`,
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
// Site approvals

const RESTRICTED = /^(chrome|chrome-extension|chrome-untrusted|edge|brave|opera|vivaldi|devtools|view-source|about):/i;
const RESTRICTED_HOSTS = ["chromewebstore.google.com", "chrome.google.com"];

export function originOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return "file://";
    return u.origin;
  } catch {
    return url;
  }
}

export function isRestricted(url: string): boolean {
  if (!url || url === "about:blank") return false;
  if (RESTRICTED.test(url)) return true;
  try {
    const u = new URL(url);
    return RESTRICTED_HOSTS.includes(u.hostname) && (u.hostname !== "chrome.google.com" || u.pathname.startsWith("/webstore"));
  } catch {
    return false;
  }
}

export interface ApprovalRequest {
  id: string;
  sessionTitle: string;
  kind: "site" | "tabs" | "upload" | "claim";
  origin?: string;
  detail?: string;
}

type Decision = "once" | "always" | "deny";
const pendingApprovals = new Map<string, { req: ApprovalRequest; resolve: (d: Decision) => void; windowId?: number }>();
const approvalDedup = new Map<string, Promise<Decision>>();

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
    .catch(() => chrome.windows.create(base));
  const p = pendingApprovals.get(id);
  if (p) p.windowId = win?.id;

  // Unanswered prompts count as "no" so the agent is never stuck forever.
  const timeout = setTimeout(() => resolveApproval(id, "deny"), 5 * 60_000);
  promise.finally(() => clearTimeout(timeout));
  return promise;
}

/** Throws unless the user (or settings) allow this thread to act on `url`. */
export async function ensureSiteAllowed(s: Session, url: string): Promise<void> {
  if (!url || url === "about:blank" || url.startsWith("data:")) return;
  if (isRestricted(url)) {
    throw new ActionError(`Chrome does not let extensions control ${originOf(url)} pages.`, "restricted");
  }
  const origin = originOf(url);
  const settings = await getSettings();
  if (settings.approvalMode === "trusted") return;
  if (settings.alwaysAllowed.includes(origin) || s.allowedOrigins.includes(origin)) return;

  const decision = await askUser({ sessionTitle: s.title, kind: "site", origin }, `site:${s.id}:${origin}`);
  if (decision === "deny") {
    throw new ActionError(`The user did not allow this thread to use ${origin}.`, "denied");
  }
  if (decision === "always") {
    const fresh = await getSettings();
    if (!fresh.alwaysAllowed.includes(origin)) await updateSettings({ alwaysAllowed: [...fresh.alwaysAllowed, origin] });
  }
  if (!s.allowedOrigins.includes(origin)) s.allowedOrigins.push(origin);
  await save();
}

export async function ensureMayListTabs(s: Session): Promise<void> {
  if (s.mayListAllTabs || (await getSettings()).approvalMode === "trusted") return;
  const d = await askUser({ sessionTitle: s.title, kind: "tabs" }, `tabs:${s.id}`);
  if (d === "deny") throw new ActionError("The user did not allow this thread to see their open tabs.", "denied");
  s.mayListAllTabs = true;
  await save();
}

export async function ensureMayClaim(s: Session, tab: chrome.tabs.Tab): Promise<void> {
  if ((await getSettings()).approvalMode !== "trusted") {
    const d = await askUser(
      { sessionTitle: s.title, kind: "claim", origin: originOf(tab.url ?? ""), detail: tab.title },
      `claim:${s.id}:${tab.id}`,
    );
    if (d === "deny") throw new ActionError("The user did not hand over that tab.", "denied");
  }
  const origin = originOf(tab.url ?? "");
  if (!s.allowedOrigins.includes(origin)) s.allowedOrigins.push(origin);
  await save();
}

export async function ensureMayUpload(s: Session, origin: string, files: string[]): Promise<void> {
  if ((await getSettings()).approvalMode === "trusted") return;
  const d = await askUser(
    { sessionTitle: s.title, kind: "upload", origin, detail: files.join("\n") },
    `upload:${s.id}:${files.join("|")}`,
  );
  if (d === "deny") throw new ActionError("The user did not allow uploading those files.", "denied");
}
