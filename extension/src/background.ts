// Service worker. Transport lives in the offscreen document (it keeps a WebSocket to the
// local daemon open even while this worker sleeps); this file holds all browser logic.

import type { EventMessage, RequestMessage, ResponseMessage } from "../../src/protocol";
import { detach, detachIdle, idleTabs, isAttached, onCdpEvent, onDetach, wasIdleDetached } from "./cdp";
import { dispatch, forgetTab, hasDialog, hideOverlay, onDialog, onStopRequest, onTabNavigated, relayTabs, showOverlay } from "./commands";
import {
  ActionError,
  addTab,
  allSessions,
  getSettings,
  markInterrupted,
  removeTab,
  sessionForTab,
  takeInterrupt,
  updateSettings,
  type Session,
} from "./sessions";
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
  if (reason === "canceled_by_user") await interruptSession(s, "cancelled debugging from Chrome's banner");
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
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => void adoptChildTab(d.tabId, d.sourceTabId));
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId !== undefined && tab.id !== undefined) void adoptChildTab(tab.id, tab.openerTabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  // Also while idle-detached: the tab is still the agent's, so the pill and Esc stay.
  if (change.status !== "complete" || !(isAttached(tabId) || wasIdleDetached(tabId))) return;
  const s = await sessionForTab(tabId);
  if (s && !s.interrupted) await showOverlay(tabId, s);
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
