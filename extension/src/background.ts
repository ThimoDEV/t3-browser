// Service worker. Transport lives in the offscreen document (it keeps a WebSocket to the
// local daemon open even while this worker sleeps); this file holds all browser logic.

import type { EventMessage, RequestMessage, ResponseMessage } from "../../src/protocol";
import { detach, detachIdle, idleTabs, isAttached, onCdpEvent, onDetach, wasIdleDetached } from "./cdp";
import { dispatch, forgetTab, hasDialog, hideOverlay, onDialog, onStopRequest, onTabNavigated, ownActivations, relayTabs, showOverlay, syncOverlay } from "./commands";
import {
  ActionError,
  addTab,
  allSessions,
  getSettings,
  markInterrupted,
  markTab,
  adoptGroupColor,
  removeTab,
  sessionForTab,
  takeInterrupt,
  updateSettings,
  type Session,
} from "./sessions";
import { tabBefore, tabToRestore } from "./focus";
import { isUsableTabUrl } from "./urls";

const OFFSCREEN_URL = "offscreen.html";
// Chrome stops this service worker whenever it is idle and starts it again on the next event,
// while the offscreen document keeps the connection. So never assume: ask it (refreshTransport).
let transportConnected = false;

async function ensureOffscreen(recreate = false): Promise<void> {
  const { port } = await getSettings();
  const url = chrome.runtime.getURL(`${OFFSCREEN_URL}?port=${port}&version=${encodeURIComponent(chrome.runtime.getManifest().version)}`);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] });
  if (contexts.length && !recreate) return;
  if (contexts.length) await chrome.offscreen.closeDocument().catch(() => {});
  await chrome.offscreen
    .createDocument({
      url,
      reasons: ["WORKERS" as chrome.offscreen.Reason],
      justification: "Keeps the connection to the local T3 Code bridge open so agents can reach the browser.",
    })
    .catch((err) => {
      if (!/single offscreen/i.test(String(err))) console.warn("offscreen", err);
    });
}

function setBadge(): void {
  chrome.action.setBadgeText({ text: transportConnected ? "" : "off" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#6b7280" }).catch(() => {});
  chrome.action
    .setTitle({ title: transportConnected ? "T3 Browser: connected to T3 Code" : "T3 Browser: waiting for T3 Code" })
    .catch(() => {});
}

/** Ask the offscreen document whether it is connected, and show that on the toolbar icon. */
async function refreshTransport(): Promise<void> {
  const connected = await chrome.runtime.sendMessage({ kind: "transport-query" }).catch(() => undefined);
  if (typeof connected === "boolean") transportConnected = connected;
  setBadge();
}

function postEvent(msg: EventMessage): void {
  chrome.runtime.sendMessage({ kind: "event", msg }).catch(() => {});
}

async function interruptSession(s: Session, reason: string): Promise<void> {
  await markInterrupted(s, reason);
  for (const tabId of s.tabIds) {
    await hideOverlay(tabId);
    await detach(tabId);
    relayTabs.delete(tabId);
  }
  postEvent({ type: "event", sessionId: s.id, event: "interrupted", data: { reason } });
}

onStopRequest((s, reason) => interruptSession(s, reason));

// ---- Idle detach ---------------------------------------------------------------------------
// Chrome shows "T3 Browser started debugging this browser" while any tab is attached. When the
// agent has not touched a tab for a while, detach from it: the bar goes away and the tab stays
// in the thread (overlay, ownership and Esc keep working). The next command reattaches.

let idleTimer: ReturnType<typeof setTimeout> | undefined;

async function detachIdleTabs(): Promise<void> {
  const { idleDetachMs } = await getSettings();
  for (const tabId of idleTabs(idleDetachMs)) {
    // agent-browser on the relay expects a persistent session; an open dialog needs its events.
    if (relayTabs.has(tabId) || hasDialog(tabId)) continue;
    // A command may have started while we detached the previous tab.
    if (!idleTabs(idleDetachMs).includes(tabId)) continue;
    await detachIdle(tabId);
  }
}

async function scheduleIdleDetach(): Promise<void> {
  const { idleDetachMs } = await getSettings();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void detachIdleTabs(), idleDetachMs + 250);
}

async function handleRpc(req: RequestMessage): Promise<ResponseMessage> {
  // A request from the daemon proves the connection is up.
  if (!transportConnected) {
    transportConnected = true;
    setBadge();
  }
  // The control page polls status; that is not the agent being busy.
  if (req.method !== "status") void scheduleIdleDetach();
  try {
    const result = await dispatch(req.session, req.method, req.params ?? {});
    return { type: "response", id: req.id, result };
  } catch (err) {
    // If the user interrupted mid-command, report that rather than a CDP detach error.
    const s = (await allSessions()).find((x) => x.id === req.session.id);
    if (s?.interrupted) {
      try {
        await takeInterrupt(s);
      } catch (e) {
        err = e;
      }
    }
    const e = err as ActionError;
    return { type: "response", id: req.id, error: { message: e.message ?? String(err), code: e.code } };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.kind) {
    case "rpc":
      handleRpc(message.msg).then(sendResponse);
      return true;
    case "transport":
      transportConnected = !!message.connected;
      setBadge();
      return false;
    case "open-thread": {
      // The page pill's thread link: open the thread in T3 Code next to the tab.
      const tab = sender.tab;
      if (tab?.id === undefined) return false;
      void sessionForTab(tab.id).then(async (s) => {
        if (s?.link) await chrome.tabs.create({ url: s.link, index: tab.index + 1, windowId: tab.windowId });
      });
      return false;
    }
    case "interrupt": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return false;
      sessionForTab(tabId).then((s) => s && interruptSession(s, message.reason === "escape" ? "pressed Esc" : "clicked Stop"));
      return false;
    }
    case "popup-state":
      (async () => {
        const sessions = await allSessions();
        const withTabs = await Promise.all(
          sessions.map(async (s) => ({
            ...s,
            tabs: (await Promise.all(s.tabIds.map((id) => chrome.tabs.get(id).catch(() => undefined))))
              .filter(Boolean)
              .map((t) => ({ tabId: t!.id, title: t!.title, url: t!.url, controlled: isAttached(t!.id!) })),
          })),
        );
        // Ask the transport itself: this worker may have restarted since it last reported.
        const connected = await chrome.runtime.sendMessage({ kind: "transport-query" }).catch(() => transportConnected);
        transportConnected = !!connected;
        setBadge();
        sendResponse({ connected: transportConnected, settings: await getSettings(), sessions: withTabs, version: chrome.runtime.getManifest().version });
      })();
      return true;
    case "popup-action":
      (async () => {
        if (message.action === "stop") {
          const s = (await allSessions()).find((x) => x.id === message.sessionId);
          if (s) await interruptSession(s, "clicked Stop in the extension");
        } else if (message.action === "show") {
          // Select all of a thread's tabs (in the window holding most of them) and bring it up.
          const s = (await allSessions()).find((x) => x.id === message.sessionId);
          const tabs = s ? (await Promise.all(s.tabIds.map((id) => chrome.tabs.get(id).catch(() => undefined)))).filter((t): t is chrome.tabs.Tab => !!t) : [];
          if (tabs.length) {
            const byWindow = new Map<number, chrome.tabs.Tab[]>();
            for (const t of tabs) byWindow.set(t.windowId, [...(byWindow.get(t.windowId) ?? []), t]);
            const [windowId, here] = [...byWindow].sort((a, b) => b[1].length - a[1].length)[0];
            if (s!.groupId !== undefined) await chrome.tabGroups.update(s!.groupId, { collapsed: false }).catch(() => {});
            await chrome.tabs.highlight({ windowId, tabs: here.map((t) => t.index) }).catch(() => {});
            await chrome.windows.update(windowId, { focused: true }).catch(() => {});
          }
        } else if (message.action === "stop-all") {
          for (const s of await allSessions()) await interruptSession(s, "clicked Stop all in the extension");
        } else if (message.action === "settings") {
          const before = await getSettings();
          const next = await updateSettings(message.patch);
          if (before.port !== next.port) await ensureOffscreen(true);
        }
        sendResponse(true);
      })();
      return true;
  }
  return false;
});

// ---- CDP events --------------------------------------------------------------------------

onCdpEvent(async (tabId, method, params: any, childSessionId) => {
  if (!childSessionId) {
    if (method === "Page.javascriptDialogOpening") onDialog(tabId, true, params);
    else if (method === "Page.javascriptDialogClosed") onDialog(tabId, false);
    else if (method === "Page.frameNavigated" && !params.frame?.parentId) onTabNavigated(tabId);
  }
  if (relayTabs.has(tabId)) {
    const s = await sessionForTab(tabId);
    if (s) postEvent({ type: "event", sessionId: s.id, event: "cdp", data: { tabId, method, params, childSessionId } });
  }
});

onDetach(async (tabId, reason) => {
  relayTabs.delete(tabId);
  const s = await sessionForTab(tabId);
  if (!s) return;
  postEvent({ type: "event", sessionId: s.id, event: "cdp.detached", data: { tabId, reason } });
  // The user clicked "Cancel" on Chrome's "is debugging this browser" bar.
  // "Cancel" on Chrome's debugging bar means: stop debugging this browser. That is every
  // thread holding tabs, also the ones whose tabs are idle-detached right now.
  if (reason === "canceled_by_user") {
    for (const other of await allSessions()) {
      if (other.tabIds.length && !other.interrupted) await interruptSession(other, "cancelled debugging from Chrome's banner");
    }
  }
});

// ---- Tab lifecycle -----------------------------------------------------------------------

chrome.tabs.onRemoved.addListener(async (tabId) => {
  forgetTab(tabId);
  relayTabs.delete(tabId);
  const s = await removeTab(tabId);
  if (s) postEvent({ type: "event", sessionId: s.id, event: "tab.removed", data: { tabId } });
});

// Pages the agent controls may open popups / target=_blank tabs: those belong to the thread too.
// webNavigation reports the source tab even for noopener links, where openerTabId is unset.
async function adoptChildTab(tabId: number, sourceTabId: number): Promise<void> {
  const s = await sessionForTab(sourceTabId);
  if (!s || s.tabIds.includes(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  // Web pages only (a fresh popup is still blank, which is fine).
  if (!tab || !isUsableTabUrl(tab.pendingUrl || tab.url || "")) return;
  await addTab(s, tabId).catch(() => {});
  postEvent({ type: "event", sessionId: s.id, event: "tab.created", data: { tabId, openerTabId: sourceTabId } });
}
// Which tab was in front before, per window, to undo a popup that jumped in front of the user.
const activeTab = new Map<number, number>();
const previousTab = new Map<number, number>();
/** Tabs just opened by a page (popup, target=_blank), with the tab that opened them. */
const openedBy = new Map<number, { source: number; at: number; authoritative: boolean }>();
void chrome.tabs.query({ active: true }).then((ts) => ts.forEach((t) => t.id !== undefined && activeTab.set(t.windowId, t.id)));

/** New tabs already judged once (an opener reported late must not reopen the question). */
const decided = new Set<number>();

/**
 * Remember who opened a new tab. webNavigation's source is the page that really opened it;
 * tabs.onCreated's openerTabId can be the tab that happened to be in front (seen in Chrome 157),
 * so it only fills in until the real source is known.
 */
function noteChild(tabId: number, source: number, authoritative: boolean): void {
  if (decided.has(tabId)) return;
  const known = openedBy.get(tabId);
  if (known && !authoritative) return;
  openedBy.set(tabId, { source, at: known?.at ?? Date.now(), authoritative });
  setTimeout(() => openedBy.delete(tabId), 5_000);
}

/**
 * A page the agent works in from the background opened a popup or a target=_blank tab, and
 * Chrome brought it to the front. Agents work in the background: put the user's tab back.
 * (When the agent's tab itself was in front, the user is watching it; leave things alone.)
 */
async function keepUserInFront(tabId: number, windowId: number, before: number | undefined): Promise<void> {
  await new Promise((r) => setTimeout(r, 50)); // the opener may be reported just after activation
  // Wait (briefly) for the real opener: until then the opener may just be the tab in front.
  for (let i = 0; i < 6 && openedBy.get(tabId) && !openedBy.get(tabId)!.authoritative; i++) await new Promise((r) => setTimeout(r, 50));
  const child = openedBy.get(tabId);
  if (!child) return;
  const restore = tabToRestore({
    tabId,
    source: child.source,
    sourceIsAgentTab: !!(await sessionForTab(child.source)),
    ageMs: Date.now() - child.at,
    before,
    ownActivation: ownActivations.has(tabId),
    alreadyDecided: decided.has(tabId),
  });
  // Creation is often reported before activation: until the new tab is really in front, there
  // is nothing to decide yet (its activation event will ask again).
  if (restore !== undefined && activeTab.get(windowId) !== tabId) return;
  // One decision per new tab: whatever happens to it later is somebody's choice.
  openedBy.delete(tabId);
  decided.add(tabId);
  setTimeout(() => decided.delete(tabId), 10_000);
  if (restore !== undefined) await chrome.tabs.update(restore, { active: true }).catch(() => {});
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const before = activeTab.get(windowId);
  if (before !== undefined && before !== tabId) previousTab.set(windowId, before);
  activeTab.set(windowId, tabId);
  void keepUserInFront(tabId, windowId, before);
  void syncIfAgentTab(tabId);
});

/** Overlays are skipped in hidden tabs: catch up when an agent's tab comes into view. */
async function syncIfAgentTab(tabId: number): Promise<void> {
  const s = await sessionForTab(tabId);
  if (s) await syncOverlay(tabId, s);
}
// The window came back to the front (it was covered or minimized): its tab is visible again.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void chrome.tabs.query({ active: true, windowId }).then(async ([t]) => {
    if (t?.id !== undefined) await syncIfAgentTab(t.id);
  });
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  noteChild(d.tabId, d.sourceTabId, true);
  void adoptChildTab(d.tabId, d.sourceTabId);
});
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId === undefined || tab.id === undefined) return;
  noteChild(tab.id, tab.openerTabId, false);
  void adoptChildTab(tab.id, tab.openerTabId);
  // Activation is often reported before the opener is known: check again now that it is.
  // "Before" is the tab in front, unless the new tab already is (then the one before that).
  if (tab.active) {
    void keepUserInFront(tab.id, tab.windowId, tabBefore(tab.id, activeTab.get(tab.windowId), previousTab.get(tab.windowId)));
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  // Chrome may drop a tab's own badge when it navigates: put the thread's number back.
  if (change.status === "loading") {
    const owner = await sessionForTab(tabId);
    if (owner) await markTab(owner, tabId);
  }
  // Also while idle-detached: the tab is still the agent's, so the pill and Esc stay.
  if (change.status !== "complete" || !(isAttached(tabId) || wasIdleDetached(tabId))) return;
  const s = await sessionForTab(tabId);
  if (s && !s.interrupted) await showOverlay(tabId, s);
});

// The user recoloured a thread's group: badges follow at once, overlays on their next show.
chrome.tabGroups.onUpdated.addListener(async (group) => {
  const s = await adoptGroupColor(group.id, group.color);
  if (s) for (const tabId of s.tabIds) if (isAttached(tabId) || wasIdleDetached(tabId)) await showOverlay(tabId, s);
});

// ---- Lifecycle ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => void ensureOffscreen());
chrome.runtime.onStartup.addListener(() => void ensureOffscreen());
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "keepalive") return;
  void ensureOffscreen().then(refreshTransport);
  // Backstop for the timer above, in case the service worker slept in between.
  void detachIdleTabs();
});
void ensureOffscreen().then(refreshTransport);
