// Service worker. Transport lives in the offscreen document (it keeps a WebSocket to the
// local daemon open even while this worker sleeps); this file holds all browser logic.

import type { EventMessage, RequestMessage, ResponseMessage } from "../../src/protocol";
import { detach, isAttached, onCdpEvent, onDetach } from "./cdp";
import { dispatch, forgetTab, hideOverlay, onDialog, onTabNavigated, relayTabs, showOverlay } from "./commands";
import {
  ActionError,
  addTab,
  allSessions,
  getApproval,
  getSettings,
  isRestricted,
  markInterrupted,
  removeTab,
  resolveApproval,
  sessionForTab,
  takeInterrupt,
  updateSettings,
  type Session,
} from "./sessions";

const OFFSCREEN_URL = "offscreen.html";
let transportConnected = false;

async function ensureOffscreen(recreate = false): Promise<void> {
  const { port } = await getSettings();
  const url = chrome.runtime.getURL(`${OFFSCREEN_URL}?port=${port}`);
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

async function handleRpc(req: RequestMessage): Promise<ResponseMessage> {
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
    case "interrupt": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return false;
      sessionForTab(tabId).then((s) => s && interruptSession(s, message.reason === "escape" ? "pressed Esc" : "clicked Stop"));
      return false;
    }
    case "approval-get":
      sendResponse(getApproval(message.id) ?? null);
      return false;
    case "approval-decide":
      resolveApproval(message.id, message.decision);
      return false;
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
  if (!tab || isRestricted(tab.pendingUrl || tab.url || "")) return;
  await addTab(s, tabId).catch(() => {});
  postEvent({ type: "event", sessionId: s.id, event: "tab.created", data: { tabId, openerTabId: sourceTabId } });
}
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => void adoptChildTab(d.tabId, d.sourceTabId));
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId !== undefined && tab.id !== undefined) void adoptChildTab(tab.id, tab.openerTabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.status !== "complete" || !isAttached(tabId)) return;
  const s = await sessionForTab(tabId);
  if (s && !s.interrupted) await showOverlay(tabId, s);
});

// ---- Lifecycle ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => void ensureOffscreen());
chrome.runtime.onStartup.addListener(() => void ensureOffscreen());
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "keepalive" && void ensureOffscreen());
void ensureOffscreen();
setBadge();
