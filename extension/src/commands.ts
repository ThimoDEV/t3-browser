// Implementation of every method the daemon can call. Each handler receives the calling
// thread's Session and validated-ish params, and returns JSON (screenshots as base64).

import type { SessionInfo, TabInfo } from "../../src/protocol";
import { attach, detach, isAttached, markBusy, onDocumentReplaced, send } from "./cdp";
import { parseKey } from "./keys";
import {
  ActionError,
  addTab,
  assertOwnsTab,
  assertUsableTab,
  assertWebUrl,
  dropSession,
  getSession,
  placeForNewTab,
  renameSession,
  sessionForTab,
  takeInterrupt,
  type Session,
} from "./sessions";
import { formatAXTree, RefAllocator, type AXNode } from "./snapshot";
import { isWebUrl, normalizeUrl, notWebPageMessage } from "./urls";

type Params = Record<string, any>;

// ---------------------------------------------------------------------------------------
// Per-tab runtime state (refs, dialogs). Lost on service-worker restart; refs then simply
// need a fresh snapshot, which the error message says.

const refAllocators = new Map<number, RefAllocator>();
const dialogs = new Map<number, { type: string; message: string; defaultPrompt?: string; url?: string }>();

export function refsFor(tabId: number): RefAllocator {
  let r = refAllocators.get(tabId);
  if (!r) refAllocators.set(tabId, (r = new RefAllocator()));
  return r;
}

export function onTabNavigated(tabId: number): void {
  refAllocators.get(tabId)?.reset();
}
onDocumentReplaced(onTabNavigated);

const dialogWaiters = new Map<number, Set<() => void>>();

export function onDialog(tabId: number, opening: boolean, params?: any): void {
  if (opening) {
    dialogs.set(tabId, { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, url: params.url });
    const waiters = dialogWaiters.get(tabId);
    dialogWaiters.delete(tabId);
    waiters?.forEach((w) => w());
  } else dialogs.delete(tabId);
}

/**
 * Input that opens alert()/confirm() blocks its CDP call until the dialog closes. Resolve as
 * soon as a dialog appears instead, so the agent sees it and can answer with browser_dialog.
 */
async function unlessDialog<T>(tabId: number, work: Promise<T>): Promise<T | undefined> {
  let remove = () => {};
  const opened = new Promise<undefined>((resolve) => {
    const set = dialogWaiters.get(tabId) ?? new Set();
    const w = () => resolve(undefined);
    set.add(w);
    dialogWaiters.set(tabId, set);
    remove = () => set.delete(w);
  });
  work.catch(() => {}); // a late rejection after the dialog won the race is not an error
  try {
    return await Promise.race([work, opened]);
  } finally {
    remove();
  }
}

export function forgetTab(tabId: number): void {
  refAllocators.delete(tabId);
  pointers.delete(tabId);
  dialogs.delete(tabId);
}

// ---------------------------------------------------------------------------------------
// Helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Settle with `work`, or reject after `ms`: no Chrome API call may hang a command. */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => {}); // a late rejection after the deadline is not an error
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ActionError(`${what} did not finish within ${ms / 1000}s.`, "timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}


function tabInfo(tab: chrome.tabs.Tab, s?: Session): TabInfo {
  return {
    tabId: tab.id!,
    url: tab.pendingUrl || tab.url || "",
    title: tab.title ?? "",
    active: !!tab.active,
    status: tab.status,
    inSession: !!s && s.tabIds.includes(tab.id!),
    windowId: tab.windowId,
  };
}

async function waitForLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  // Give a click a moment to start a navigation before deciding nothing happened.
  await sleep(150);
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) throw new ActionError("The tab was closed.", "tab_closed");
    if (tab.status === "complete") return;
    await sleep(150);
  }
}

type OverlayFn = "show" | "hide" | "moveTo" | "click" | "activity" | "agentActing";

async function overlay(tabId: number, fn: OverlayFn, ...args: unknown[]): Promise<void> {
  // executeScript waits for the document to become idle, which a slow page (a dev server
  // compiling its first request) may not reach for a long time. The overlay is shown again
  // when the page finishes loading, so give up quickly here.
  await withDeadline(overlayNow(tabId, fn, args), 3_000, "Showing the overlay").catch(() => {});
}

async function overlayNow(tabId: number, fn: string, args: unknown[]): Promise<void> {
  try {
    if (fn === "show") {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] });
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (f: string, a: unknown[]) => {
        const o = (window as any).__t3BrowserOverlay;
        // moveTo returns a promise; executeScript waits for it, so the glide finishes first.
        if (o && typeof o[f] === "function") return o[f](...a);
      },
      args: [fn, args],
    });
  } catch {
    // Overlays are cosmetic; restricted pages and mid-navigation documents just skip them.
  }
}

// ---- The agent's visible cursor ------------------------------------------------------------
// Where the cursor last was in each tab, so after a navigation it continues from there.
const pointers = new Map<number, { x: number; y: number }>();

/** Glide the agent cursor to (x, y) and wait until it arrives (instant in background tabs). */
async function glideTo(tabId: number, x: number, y: number, activity: string | null = null): Promise<void> {
  const from = pointers.get(tabId) ?? null;
  pointers.set(tabId, { x, y });
  await overlay(tabId, "moveTo", x, y, from, activity);
}

/** The element's on-screen centre, without hit-testing (for typing and selecting). */
async function centerOf(tabId: number, backendNodeId: number): Promise<{ x: number; y: number } | undefined> {
  try {
    const { quads } = await send<{ quads: number[][] }>(tabId, "DOM.getContentQuads", { backendNodeId });
    const q = quads?.[0];
    if (!q) return undefined;
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
  } catch {
    return undefined;
  }
}

/** Tabs where the overlay is (meant to be) showing. */
const overlayShown = new Set<number>();

export async function showOverlay(tabId: number, s: Session): Promise<void> {
  overlayShown.add(tabId);
  await overlay(tabId, "show", `T3 Code is using this tab · ${s.title}`, !!s.link);
}

/** A dialog is open on the tab (keep the debugger attached so its events keep flowing). */
export function hasDialog(tabId: number): boolean {
  return dialogs.has(tabId);
}

let stopHandler: ((s: Session, reason: string) => Promise<void>) | undefined;
/** The background registers how to interrupt a thread (Esc / Stop use the same path). */
export function onStopRequest(fn: (s: Session, reason: string) => Promise<void>): void {
  stopHandler = fn;
}

export async function hideOverlay(tabId: number): Promise<void> {
  overlayShown.delete(tabId);
  await overlay(tabId, "hide");
}

/** Common entry for anything that touches a page: ownership, interrupts, web pages only, debugger. */
async function prepare(s: Session, tabId: number): Promise<chrome.tabs.Tab> {
  await takeInterrupt(s);
  assertOwnsTab(s, tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => {
    throw new ActionError(`Tab ${tabId} no longer exists.`, "tab_closed");
  });
  assertUsableTab(tab);
  const dialog = dialogs.get(tabId);
  if (dialog) {
    throw new ActionError(
      `A ${dialog.type} dialog is open on this tab: ${JSON.stringify(dialog.message)}. Handle it with browser_dialog first.`,
      "dialog_open",
    );
  }
  if (!isAttached(tabId)) {
    await attach(tabId);
    await showOverlay(tabId, s);
  }
  return tab;
}

function resolveRef(tabId: number, ref: string) {
  const key = ref.replace(/^@/, "").replace(/^ref=/, "");
  const target = refsFor(tabId).targets.get(key);
  if (!target) {
    throw new ActionError(`Unknown ref "${ref}". Refs expire when the page changes; take a new browser_snapshot.`, "stale_ref");
  }
  return target;
}

async function objectIdFor(tabId: number, backendNodeId: number): Promise<string> {
  try {
    const { object } = await send(tabId, "DOM.resolveNode", { backendNodeId });
    return object.objectId;
  } catch {
    throw new ActionError("That element is gone from the page. Take a new browser_snapshot.", "stale_ref");
  }
}

async function callOn<T = any>(tabId: number, objectId: string, fn: string, args: unknown[] = []): Promise<T> {
  const res = await send(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) throw new ActionError(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res.result?.value as T;
}

/** Scroll into view, find the element's centre, and verify nothing covers it. */
async function clickablePoint(tabId: number, backendNodeId: number): Promise<{ x: number; y: number }> {
  await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  let quads: number[][] = [];
  try {
    ({ quads } = await send(tabId, "DOM.getContentQuads", { backendNodeId }));
  } catch {
    // fallthrough
  }
  if (!quads?.length) throw new ActionError("That element is not visible (it has no on-screen box).", "not_visible");
  const q = quads[0];
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;

  const objectId = await objectIdFor(tabId, backendNodeId);
  const blocker = await callOn<string | null>(
    tabId,
    objectId,
    `function (x, y) {
      if (this.ownerDocument !== document) return null; // inside an iframe: skip hit-testing
      let hit = document.elementFromPoint(x, y);
      while (hit && hit.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      if (!hit || hit.tagName === "T3-BROWSER-OVERLAY") return null;
      const self = this.nodeType === 1 ? this : this.parentElement;
      if (!self || self === hit || self.contains(hit) || hit.contains(self)) return null;
      if (self.getRootNode() instanceof ShadowRoot && self.getRootNode().host.contains(hit)) return null;
      if (hit.closest && self.closest && hit.closest("label") && hit.closest("label").control === self) return null;
      const d = hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") +
        (typeof hit.className === "string" && hit.className.trim() ? "." + hit.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
      const text = (hit.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 80);
      return d + (text ? ' "' + text + '"' : "");
    }`,
    [x, y],
  );
  if (blocker) {
    throw new ActionError(
      `The element is covered by ${blocker}. Dismiss it (e.g. a cookie banner or modal), take a new snapshot, and retry.`,
      "covered",
    );
  }
  return { x, y };
}

async function mouseClick(tabId: number, x: number, y: number, button = "left", clickCount = 1, activity: string | null = null): Promise<void> {
  // Show the move first, then the click, then send the real input: the user sees what the
  // agent is about to do instead of a jump.
  await glideTo(tabId, x, y, activity);
  await overlay(tabId, "agentActing", 800);
  await overlay(tabId, "click", x, y);
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let i = 1; i <= clickCount; i++) {
    await unlessDialog(tabId, send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i }));
    if (dialogs.has(tabId)) return;
    await unlessDialog(tabId, send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i }));
    if (dialogs.has(tabId)) return;
  }
}

async function pressKey(tabId: number, chord: string): Promise<void> {
  const k = parseKey(chord);
  if (k.key === "Escape") await overlay(tabId, "agentActing", 800);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
  await unlessDialog(tabId, send(tabId, "Input.dispatchKeyEvent", { ...base, type: k.text ? "keyDown" : "rawKeyDown", text: k.text, unmodifiedText: k.text }));
  if (dialogs.has(tabId)) return;
  await unlessDialog(tabId, send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" }));
}

async function pageState(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  const dialog = dialogs.get(tabId);
  return { tabId, url: tab.url, title: tab.title, ...(dialog ? { dialog } : {}) };
}

/** Act, then report where we ended up (navigations from clicks are common). */
async function afterAction(tabId: number, before: string | undefined) {
  if (!dialogs.has(tabId)) await waitForLoad(tabId, 10_000).catch(() => {});
  const state = await pageState(tabId);
  return { ...state, navigated: !!before && state.url !== before };
}

/**
 * Chrome does not paint background tabs, so a capture there never completes. Try anyway
 * (it works when the tab is visible, e.g. in its own window), then briefly bring the tab to
 * the front of its window, capture, and put the user's tab back.
 */
async function captureEvenIfHidden(tabId: number, params: Record<string, unknown>): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.active) return (await send<{ data: string }>(tabId, "Page.captureScreenshot", params)).data;
  try {
    return (await send<{ data: string }>(tabId, "Page.captureScreenshot", params, undefined, 2_500)).data;
  } catch {
    // fall through to the visible capture
  }
  const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await chrome.tabs.update(tabId, { active: true });
  try {
    await sleep(200);
    return (await send<{ data: string }>(tabId, "Page.captureScreenshot", params, undefined, 15_000)).data;
  } finally {
    if (previous?.id !== undefined && previous.id !== tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------
// Handlers

export const handlers: Record<string, (s: Session, p: Params) => Promise<unknown>> = {
  async status(s) {
    const tabs = await Promise.all(s.tabIds.map((id) => chrome.tabs.get(id).catch(() => undefined)));
    const group = s.groupId === undefined ? undefined : await chrome.tabGroups.get(s.groupId).catch(() => undefined);
    return {
      session: { id: s.id, title: s.title, link: s.link, groupId: group?.id, ...(group ? { group: { title: group.title, color: group.color, windowId: group.windowId } } : {}) },
      tabs: tabs.filter(Boolean).map((t) => tabInfo(t!, s)),
      userAgent: navigator.userAgent,
    };
  },

  async "session.name"(s, p) {
    s.named = true;
    await renameSession(s, String(p.title));
    for (const id of s.tabIds) if (isAttached(id)) await showOverlay(id, s);
    return { title: s.title };
  },

  async "tabs.list"(s, p) {
    await takeInterrupt(s);
    if (p.scope === "all") {
      // Only web tabs: browser pages cannot be claimed, so there is no reason to show them.
      const tabs = await chrome.tabs.query({ windowType: "normal" });
      return tabs.filter((t) => isWebUrl(t.url || t.pendingUrl || "")).map((t) => tabInfo(t, s));
    }
    const tabs = await Promise.all(s.tabIds.map((id) => chrome.tabs.get(id).catch(() => undefined)));
    return tabs.filter(Boolean).map((t) => tabInfo(t!, s));
  },

  // No permission prompt: if the extension is connected, the tab simply opens, inside this
  // thread's tab group. Every wait below is bounded, so the agent gets an answer well before
  // the daemon gives up on the call.
  async "tabs.open"(s, p) {
    await takeInterrupt(s);
    const url = normalizeUrl(String(p.url ?? "about:blank"));
    assertWebUrl(url);
    const active = !!p.active;
    const { windowId, index } = await placeForNewTab(s);
    const tab = await chrome.tabs.create({ url, active, windowId, ...(index !== undefined ? { index } : {}) });
    const tabId = tab.id!;
    await addTab(s, tabId);
    if (active) {
      await chrome.windows.update(windowId, { focused: true }).catch(() => {});
      if (s.groupId !== undefined) await chrome.tabGroups.update(s.groupId, { collapsed: false }).catch(() => {});
    }
    await waitForLoad(tabId, 15_000).catch(() => {});
    // Attaching now lets the agent act at once. A failure is not fatal: the first action
    // attaches again and reports a precise error.
    await attach(tabId).catch(() => {});
    if (isAttached(tabId)) await showOverlay(tabId, s);
    const now = await chrome.tabs.get(tabId);
    assertUsableTab(now);
    return tabInfo(now, s);
  },

  async "tabs.claim"(s, p) {
    await takeInterrupt(s);
    const tabId = Number(p.tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => {
      throw new ActionError(`Tab ${tabId} does not exist.`, "tab_closed");
    });
    const owner = await sessionForTab(tabId);
    if (owner && owner.id !== s.id) throw new ActionError("Another T3 thread is already using that tab.", "ownership_conflict");
    const url = tab.url || tab.pendingUrl || "";
    if (!isWebUrl(url)) throw new ActionError(notWebPageMessage(url), "restricted");
    await addTab(s, tabId);
    await attach(tabId);
    await showOverlay(tabId, s);
    return tabInfo(await chrome.tabs.get(tabId), s);
  },

  async "tabs.close"(s, p) {
    const tabId = Number(p.tabId);
    assertOwnsTab(s, tabId);
    await chrome.tabs.remove(tabId).catch(() => {});
    return { closed: tabId };
  },

  async "tabs.navigate"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const action = p.action ?? "goto";
    if (action === "goto") {
      const url = normalizeUrl(String(p.url));
      assertWebUrl(url);
      await chrome.tabs.update(tabId, { url });
    } else if (action === "back") await chrome.tabs.goBack(tabId);
    else if (action === "forward") await chrome.tabs.goForward(tabId);
    else if (action === "reload") await chrome.tabs.reload(tabId);
    else throw new ActionError(`Unknown navigation action "${action}".`);
    onTabNavigated(tabId);
    await waitForLoad(tabId);
    // Going back can leave the web (e.g. to a browser page the tab showed earlier).
    assertUsableTab(await chrome.tabs.get(tabId));
    return pageState(tabId);
  },

  async "page.snapshot"(s, p) {
    const tabId = Number(p.tabId);
    const tab = await prepare(s, tabId);
    await send(tabId, "Accessibility.enable").catch(() => {});
    const { nodes } = await send<{ nodes: AXNode[] }>(tabId, "Accessibility.getFullAXTree", {});

    // Graft same-process iframes in at their <iframe> node.
    const frames = new Map<number, AXNode[]>();
    for (const n of nodes) {
      if (n.role?.value !== "Iframe" || n.backendDOMNodeId === undefined) continue;
      try {
        const { node } = await send(tabId, "DOM.describeNode", { backendNodeId: n.backendDOMNodeId });
        if (!node.frameId) continue;
        const sub = await send<{ nodes: AXNode[] }>(tabId, "Accessibility.getFullAXTree", { frameId: node.frameId });
        frames.set(n.backendDOMNodeId, sub.nodes);
      } catch {
        // cross-process iframe: not reachable from this target in v1
      }
    }

    let scoped = nodes;
    if (p.selector) {
      const { result } = await send(tabId, "Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(p.selector)})` });
      if (!result?.objectId) throw new ActionError(`No element matches selector ${p.selector}.`);
      const { node } = await send(tabId, "DOM.describeNode", { objectId: result.objectId });
      const rootAx = nodes.find((n) => n.backendDOMNodeId === node.backendNodeId);
      if (!rootAx) throw new ActionError(`The element matching ${p.selector} is not in the accessibility tree.`);
      const byId = new Map(nodes.map((n) => [n.nodeId, n]));
      const subtree: AXNode[] = [];
      const stack = [rootAx.nodeId];
      while (stack.length) {
        const n = byId.get(stack.pop()!);
        if (!n) continue;
        subtree.push(n.nodeId === rootAx.nodeId ? { ...n, parentId: undefined } : n);
        stack.push(...(n.childIds ?? []));
      }
      scoped = subtree;
    }

    const refs = refsFor(tabId);
    const result = formatAXTree(scoped, refs, { interactive: !!p.interactive, maxDepth: p.maxDepth, maxChars: p.maxChars }, frames);
    if (!p.selector) refs.retainOnly(result.refs);
    const dialog = dialogs.get(tabId);
    return {
      tabId,
      url: tab.url,
      title: tab.title,
      snapshot: result.text || "(empty page)",
      refCount: result.refs.size,
      ...(dialog ? { dialog } : {}),
    };
  },

  async "page.click"(s, p) {
    const tabId = Number(p.tabId);
    const tab = await prepare(s, tabId);
    let x: number;
    let y: number;
    if (p.ref) {
      ({ x, y } = await clickablePoint(tabId, resolveRef(tabId, p.ref).backendNodeId));
    } else if (typeof p.x === "number" && typeof p.y === "number") {
      ({ x, y } = p as { x: number; y: number });
    } else throw new ActionError("Pass a ref from browser_snapshot (or x/y coordinates).");
    await mouseClick(tabId, x, y, p.button ?? "left", p.doubleClick ? 2 : 1);
    return afterAction(tabId, tab.url);
  },

  async "page.hover"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const { x, y } = await clickablePoint(tabId, resolveRef(tabId, p.ref).backendNodeId);
    await glideTo(tabId, x, y);
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    return pageState(tabId);
  },

  async "page.type"(s, p) {
    const tabId = Number(p.tabId);
    const tab = await prepare(s, tabId);
    const text = String(p.text ?? "");
    if (p.ref) {
      const { backendNodeId } = resolveRef(tabId, p.ref);
      await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
      const field = await centerOf(tabId, backendNodeId);
      if (field) await glideTo(tabId, field.x, field.y, "Typing");
      try {
        await send(tabId, "DOM.focus", { backendNodeId });
      } catch {
        // Some widgets only take focus from a click.
        const { x, y } = await clickablePoint(tabId, backendNodeId);
        await mouseClick(tabId, x, y, "left", 1, "Typing");
      }
      if (p.clear !== false) {
        const objectId = await objectIdFor(tabId, backendNodeId);
        await callOn(
          tabId,
          objectId,
          `function () {
            const el = this;
            if (typeof el.select === "function" && "value" in el) { el.select(); return; }
            if (el.isContentEditable) {
              const r = document.createRange(); r.selectNodeContents(el);
              const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
            }
          }`,
        );
        if (!text) await pressKey(tabId, "Delete");
      }
    }
    if (!p.ref) await overlay(tabId, "activity", "Typing");
    try {
      if (text) await unlessDialog(tabId, send(tabId, "Input.insertText", { text }));
      if (p.submit && !dialogs.has(tabId)) await pressKey(tabId, "Enter");
    } finally {
      await overlay(tabId, "activity", null);
    }
    return afterAction(tabId, tab.url);
  },

  async "page.press"(s, p) {
    const tabId = Number(p.tabId);
    const tab = await prepare(s, tabId);
    const keys: string[] = Array.isArray(p.keys) ? p.keys : [String(p.key ?? p.keys)];
    for (const k of keys) await pressKey(tabId, k);
    return afterAction(tabId, tab.url);
  },

  async "page.scroll"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    if (p.ref && !p.direction) {
      const { backendNodeId } = resolveRef(tabId, p.ref);
      await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } else {
      const amount = Number(p.amount ?? 600);
      const dir = String(p.direction ?? "down");
      const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
      const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
      // Scroll the nearest scrollable container under the ref (or the page). Programmatic
      // scrolling works in background tabs, where synthetic wheel events are never delivered.
      const fn = `function (dx, dy) {
        const canScroll = (el) => {
          if (!el || el === document.body || el === document.documentElement) return false;
          const st = getComputedStyle(el);
          return (/(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight) ||
                 (/(auto|scroll|overlay)/.test(st.overflowX) && el.scrollWidth > el.clientWidth);
        };
        let el = this && this.nodeType ? (this.nodeType === 1 ? this : this.parentElement) : null;
        while (el && !canScroll(el)) el = el.parentElement;
        const target = el || document.scrollingElement || document.documentElement;
        target.scrollBy({ left: dx, top: dy, behavior: "instant" });
        return true;
      }`;
      if (p.ref) await callOn(tabId, await objectIdFor(tabId, resolveRef(tabId, p.ref).backendNodeId), fn, [dx, dy]);
      else await send(tabId, "Runtime.evaluate", { expression: `(${fn}).call(null, ${dx}, ${dy})`, returnByValue: true });
      await sleep(150);
    }
    const { result } = await send(tabId, "Runtime.evaluate", {
      expression: "({x: scrollX, y: scrollY, maxY: document.documentElement.scrollHeight - innerHeight})",
      returnByValue: true,
    });
    return { ...(await pageState(tabId)), scroll: result.value };
  },

  async "page.select"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const values: string[] = Array.isArray(p.values) ? p.values.map(String) : [String(p.values ?? p.value)];
    const { backendNodeId } = resolveRef(tabId, p.ref);
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
    const box = await centerOf(tabId, backendNodeId);
    if (box) {
      await glideTo(tabId, box.x, box.y, "Selecting");
      await overlay(tabId, "click", box.x, box.y);
      await overlay(tabId, "activity", null);
    }
    const objectId = await objectIdFor(tabId, backendNodeId);
    const selected = await callOn<string[] | string>(
      tabId,
      objectId,
      `function (wanted) {
        if (!(this instanceof HTMLSelectElement)) return "not-a-select";
        const opts = [...this.options];
        const picked = [];
        for (const o of opts) {
          const hit = wanted.some(w => o.value === w || o.label.trim() === w || o.text.trim() === w);
          if (hit && (this.multiple || picked.length === 0)) { o.selected = true; picked.push(o.label || o.value); }
          else if (this.multiple) o.selected = false;
        }
        if (!picked.length) return "no-match:" + opts.map(o => o.label || o.value).slice(0, 30).join(" | ");
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return picked;
      }`,
      [values],
    );
    if (selected === "not-a-select") throw new ActionError("That element is not a native <select>. Click it to open the menu, then click an option.");
    if (typeof selected === "string") throw new ActionError(`No option matches. Options: ${selected.slice("no-match:".length)}`);
    return { ...(await pageState(tabId)), selected };
  },

  async "page.screenshot"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const format = p.format === "png" ? "png" : "jpeg";
    const params: Record<string, unknown> = { format, ...(format === "jpeg" ? { quality: 80 } : {}) };
    if (p.fullPage) {
      const m = await send(tabId, "Page.getLayoutMetrics");
      const width = Math.ceil(m.cssContentSize.width);
      const height = Math.min(Math.ceil(m.cssContentSize.height), 12_000);
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
    }
    await overlay(tabId, "hide");
    try {
      const data = await captureEvenIfHidden(tabId, params);
      return { ...(await pageState(tabId)), mimeType: `image/${format}`, data };
    } finally {
      await showOverlay(tabId, s);
    }
  },

  /**
   * The control page's Peek button. Unlike page.screenshot it never consumes an Esc/Stop
   * notice meant for the agent, and it refuses once the thread is stopped.
   */
  async "page.peek"(s, p) {
    const tabId = Number(p.tabId);
    if (s.interrupted) throw new ActionError("This thread is stopped.", "interrupted");
    assertOwnsTab(s, tabId);
    assertUsableTab(await chrome.tabs.get(tabId));
    if (dialogs.has(tabId)) throw new ActionError("A dialog is open on this tab; the agent has to answer it first.", "dialog_open");
    // Leave the tab exactly as it was: overlay only if it was showing, debugger only if attached.
    const wasAttached = isAttached(tabId);
    const hadOverlay = overlayShown.has(tabId);
    if (!wasAttached) await attach(tabId);
    if (hadOverlay) await overlay(tabId, "hide");
    try {
      return { mimeType: "image/jpeg", data: await captureEvenIfHidden(tabId, { format: "jpeg", quality: 70 }) };
    } finally {
      if (hadOverlay) await overlay(tabId, "show", `T3 Code is using this tab · ${s.title}`, !!s.link);
      if (!wasAttached) await detach(tabId);
    }
  },

  async "page.read"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const offset = Number(p.offset ?? 0);
    const maxChars = Number(p.maxChars ?? 20_000);
    const { result, exceptionDetails } = await send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const root = ${p.selector ? `document.querySelector(${JSON.stringify(p.selector)})` : "document.body"};
        return root ? root.innerText : null;
      })()`,
      returnByValue: true,
    });
    if (exceptionDetails) throw new ActionError(exceptionDetails.text);
    if (result.value === null) throw new ActionError(`No element matches selector ${p.selector}.`);
    const text = String(result.value ?? "").replace(/\n{3,}/g, "\n\n");
    return {
      ...(await pageState(tabId)),
      text: text.slice(offset, offset + maxChars),
      totalChars: text.length,
      ...(offset + maxChars < text.length ? { nextOffset: offset + maxChars } : {}),
    };
  },

  async "page.eval"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const res = await unlessDialog(
      tabId,
      send(tabId, "Runtime.evaluate", { expression: String(p.expression), awaitPromise: true, returnByValue: true, userGesture: true, timeout: 30_000 }),
    );
    if (!res) return { value: null, dialog: dialogs.get(tabId) };
    const { result, exceptionDetails } = res;
    if (exceptionDetails) throw new ActionError(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return { value: result.value ?? (result.type === "undefined" ? null : result.description) };
  },

  async "page.wait"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const timeout = Math.min(Number(p.timeoutMs ?? 10_000), 60_000);
    const start = Date.now();
    if (!p.text && !p.selector && !p.urlIncludes) {
      if (p.ms) {
        await sleep(Math.min(Number(p.ms), 30_000));
        return pageState(tabId);
      }
      await waitForLoad(tabId, timeout);
      return pageState(tabId);
    }
    const expr = `(() => {
      ${p.text ? `if (!document.body || !document.body.innerText.includes(${JSON.stringify(p.text)})) return ${!!p.gone};` : ""}
      ${p.selector ? `{ const el = document.querySelector(${JSON.stringify(p.selector)}); if (!el || !(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return ${!!p.gone}; }` : ""}
      ${p.urlIncludes ? `if (!location.href.includes(${JSON.stringify(p.urlIncludes)})) return ${!!p.gone};` : ""}
      return ${!p.gone};
    })()`;
    while (Date.now() - start < timeout) {
      await takeInterrupt(s);
      const { result } = await send(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true }).catch(() => ({ result: { value: false } }));
      if (result.value === true) return { ...(await pageState(tabId)), waitedMs: Date.now() - start };
      await sleep(250);
    }
    throw new ActionError(`Timed out after ${timeout}ms waiting for ${JSON.stringify({ text: p.text, selector: p.selector, urlIncludes: p.urlIncludes, gone: !!p.gone })}.`, "timeout");
  },

  async "page.upload"(s, p) {
    const tabId = Number(p.tabId);
    const tab = await prepare(s, tabId);
    const files: string[] = (Array.isArray(p.files) ? p.files : [p.files]).map(String);
    await send(tabId, "DOM.setFileInputFiles", { files, backendNodeId: resolveRef(tabId, p.ref).backendNodeId });
    return { ...(await pageState(tabId)), uploaded: files };
  },

  async "page.dialog"(s, p) {
    const tabId = Number(p.tabId);
    await takeInterrupt(s);
    assertOwnsTab(s, tabId);
    const dialog = dialogs.get(tabId);
    if (!dialog) {
      // A dialog that opened while the debugger was detached (idle) was never reported: try anyway.
      if (!isAttached(tabId)) await attach(tabId);
      try {
        await send(tabId, "Page.handleJavaScriptDialog", { accept: !!p.accept, promptText: p.promptText });
      } catch {
        throw new ActionError("No dialog is open on this tab.");
      }
      return { handled: { type: "dialog" }, accepted: !!p.accept };
    }
    await send(tabId, "Page.handleJavaScriptDialog", { accept: !!p.accept, promptText: p.promptText });
    dialogs.delete(tabId);
    return { handled: dialog, accepted: !!p.accept };
  },

  // browser_done: close the agent's tabs except keepTabIds, which leave the group.
  // keepGroup (the thread ended without browser_done): keep every tab, in its group, collapsed,
  // so the user still finds what the agent was doing, but with the debugger and overlay gone.
  async "session.release"(s, p) {
    const keep = new Set<number>((p.keepTabIds ?? []).map(Number));
    const keepGroup = p.keepGroup === true;
    const closeTabs = !keepGroup && p.closeTabs !== false;
    for (const tabId of [...s.tabIds]) {
      await hideOverlay(tabId);
      await detach(tabId);
      // The in-memory attach state is lost if the service worker restarted; detach anyway so
      // tabs that stay open never keep Chrome's "debugging this browser" bar.
      await chrome.debugger.detach({ tabId }).catch(() => {});
      forgetTab(tabId);
      relayTabs.delete(tabId);
      if (closeTabs && !keep.has(tabId)) await chrome.tabs.remove(tabId).catch(() => {});
      else if (!keepGroup) await chrome.tabs.ungroup(tabId).catch(() => {});
    }
    const kept = keepGroup ? s.tabIds.length : closeTabs ? s.tabIds.filter((id) => keep.has(id)).length : s.tabIds.length;
    if (keepGroup && s.groupId !== undefined) {
      // Collapsing would pull the user off a tab they are looking at; leave the group open then.
      const watched = await chrome.tabs.query({ groupId: s.groupId, active: true }).catch(() => []);
      if (!watched.length) await chrome.tabGroups.update(s.groupId, { collapsed: true }).catch(() => {});
    }
    await dropSession(s.id);
    return { released: true, kept };
  },

  /** Stop the thread as if the user pressed Stop (used by the remote control page). */
  async "session.stop"(s, p) {
    await stopHandler?.(s, String(p.reason ?? "pressed Stop on the T3 Browser control page"));
    return { stopped: s.id };
  },

  /** Load the build that is on disk now (used by `t3-browser reload-extension` after a rebuild). */
  async "extension.reload"() {
    setTimeout(() => chrome.runtime.reload(), 150);
    return { reloading: true, version: chrome.runtime.getManifest().version };
  },

  // ---- CDP relay (agent-browser `connect`) --------------------------------------------

  async "cdp.attach"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    relayTabs.add(tabId);
    return { attached: tabId };
  },

  async "cdp.detach"(_s, p) {
    relayTabs.delete(Number(p.tabId));
    return {};
  },

  async "cdp.send"(s, p) {
    const tabId = Number(p.tabId);
    await takeInterrupt(s);
    assertOwnsTab(s, tabId);
    const method = String(p.method);
    if (method === "Page.navigate" && p.params?.url) assertWebUrl(String(p.params.url));
    if (!isAttached(tabId)) await attach(tabId);
    try {
      return await send(tabId, method, p.params, p.childSessionId);
    } catch (err) {
      throw new ActionError(String((err as Error).message ?? err), "cdp_error");
    }
  },
};

/** Tabs whose CDP events are streamed to the daemon for the relay. */
export const relayTabs = new Set<number>();

export async function dispatch(info: SessionInfo, method: string, params: Params = {}): Promise<unknown> {
  const handler = handlers[method];
  if (!handler) throw new ActionError(`Unknown method ${method}`, "unknown_method");
  const s = await getSession(info);
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) return handler(s, params);
  const done = markBusy(tabId);
  try {
    return await handler(s, params);
  } finally {
    done();
  }
}
