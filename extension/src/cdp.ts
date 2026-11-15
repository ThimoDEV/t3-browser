// Thin wrapper around chrome.debugger: one attachment per tab, shared by the built-in
// commands and by the CDP relay that agent-browser connects through.

type EventListener = (tabId: number, method: string, params: unknown, childSessionId?: string) => void;
type DetachListener = (tabId: number, reason: string) => void;

const ATTACH_TIMEOUT_MS = 10_000;
const attached = new Set<number>();
/** When each attached tab last sent or received a command, for detaching idle tabs. */
const lastUsed = new Map<number, number>();
/** Commands in flight per tab: never detach a tab in the middle of one. */
const busy = new Map<number, number>();
/** The main document (loaderId) a tab showed when we detached, to notice navigations meanwhile. */
const docAtDetach = new Map<number, string>();
/** Tabs we detached only because the agent was idle (still the agent's, overlay still shown). */
const idleDetached = new Set<number>();
const replacedListeners = new Set<(tabId: number) => void>();

/** Called when a tab shows a different document than when we last detached from it. */
export function onDocumentReplaced(l: (tabId: number) => void): void {
  replacedListeners.add(l);
}

/** Mark a command on the tab as running; call the returned function when it is done. */
export function markBusy(tabId: number): () => void {
  busy.set(tabId, (busy.get(tabId) ?? 0) + 1);
  lastUsed.set(tabId, Date.now());
  return () => {
    const n = (busy.get(tabId) ?? 1) - 1;
    if (n > 0) busy.set(tabId, n);
    else busy.delete(tabId);
    lastUsed.set(tabId, Date.now());
  };
}

export function wasIdleDetached(tabId: number): boolean {
  return idleDetached.has(tabId);
}

async function mainDocument(tabId: number): Promise<string | undefined> {
  try {
    const { frameTree } = await send<{ frameTree: { frame: { loaderId: string } } }>(tabId, "Page.getFrameTree", {}, undefined, 2_000);
    return frameTree.frame.loaderId;
  } catch {
    return undefined;
  }
}
const attaching = new Map<number, Promise<void>>();
const eventListeners = new Set<EventListener>();
const detachListeners = new Set<DetachListener>();

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return;
  for (const l of eventListeners) l(source.tabId, method, params, (source as { sessionId?: string }).sessionId);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  for (const l of detachListeners) l(source.tabId, reason);
});

export function onCdpEvent(l: EventListener): void {
  eventListeners.add(l);
}

export function onDetach(l: DetachListener): void {
  detachListeners.add(l);
}

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

/** Detaches in progress: an attach waits for them instead of racing them. */
const detaching = new Map<number, Promise<void>>();

/** Commands running on the tab right now (see markBusy). */
export function busyCount(tabId: number): number {
  return busy.get(tabId) ?? 0;
}

export async function attach(tabId: number): Promise<void> {
  const leaving = detaching.get(tabId);
  if (leaving) await leaving.catch(() => {});
  if (attached.has(tabId)) return;
  const inFlight = attaching.get(tabId);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      // Bounded, so a tab that never lets the debugger in cannot hang a command.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        chrome.debugger.attach({ tabId }, "1.3"),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("Chrome did not let the debugger attach within 10s")), ATTACH_TIMEOUT_MS))),
      ]).finally(() => clearTimeout(timer));
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      // "Already attached" is fine when it is us (a previous service-worker life): adopt it.
      // DevTools or another extension on the tab is not; say so instead of failing later.
      if (/already attached/i.test(msg)) {
        // Ours from a previous service-worker life answers commands; someone else's does not.
        // (getTargets cannot tell: its extensionId describes background pages, not the client.)
        // Bounded: an open alert() or a frozen page makes the probe hang, and that is still ours.
        const ours = await Promise.race([
          chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1", returnByValue: true }).then(() => true, () => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2_000)),
        ]);
        if (!ours) throw new Error("Another extension is already debugging this tab. Stop it there (or disable that extension) and try again.");
      } else {
        throw new Error(
          /Cannot access|chrome:\/\/|chrome-extension:\/\//i.test(msg)
            ? "Chrome does not allow extensions to control this page (browser-internal or Web Store page)."
            : `Could not attach to the tab: ${msg}`,
        );
      }
    }
    attached.add(tabId);
    idleDetached.delete(tabId);
    lastUsed.set(tabId, Date.now());
    // Refs point at nodes of the document we saw. If the tab navigated while we were away (a
    // redirect, a refresh, the user), they must not be reused: a new renderer reuses node ids.
    const before = docAtDetach.get(tabId);
    docAtDetach.delete(tabId);
    if (before !== undefined && (await mainDocument(tabId)) !== before) replacedListeners.forEach((l) => l(tabId));
    // Page events report dialogs and navigations. Runtime is not enabled: nothing here uses its
    // events (evaluating code works without it), and enabling it streams every console message
    // and execution context of the page to the extension. It was also a classic bot-detection
    // signal in older Chrome versions. CDP clients on the relay may still enable it themselves.
    await send(tabId, "Page.enable").catch(() => {});
  })().finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}

/** Attached tabs with no command running and none sent for at least `ms`. */
export function idleTabs(ms: number): number[] {
  const cutoff = Date.now() - ms;
  return [...attached].filter((tabId) => !busy.has(tabId) && (lastUsed.get(tabId) ?? 0) <= cutoff);
}

/** Detach because the agent is idle: the tab stays the agent's and reattaches on the next command. */
export async function detachIdle(tabId: number): Promise<void> {
  await detach(tabId);
  idleDetached.add(tabId);
}

export async function detach(tabId: number): Promise<void> {
  lastUsed.delete(tabId);
  idleDetached.delete(tabId);
  if (!attached.has(tabId)) return;
  // Not attached from this moment on, so a command starting now reattaches (after waiting for
  // this detach) instead of sending into a session that is going away.
  attached.delete(tabId);
  const p = (async () => {
    const doc = await mainDocument(tabId);
    if (doc !== undefined) docAtDetach.set(tabId, doc);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  })();
  detaching.set(tabId, p);
  try {
    await p;
  } finally {
    if (detaching.get(tabId) === p) detaching.delete(tabId);
  }
}

const SEND_TIMEOUT_MS = 30_000;

export async function send<T = any>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
  childSessionId?: string,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<T> {
  lastUsed.set(tabId, Date.now());
  const target: chrome.debugger.Debuggee & { sessionId?: string } = { tabId };
  if (childSessionId) target.sessionId = childSessionId;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      chrome.debugger.sendCommand(target, method, params),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} did not answer within ${timeoutMs / 1000}s (the page may be frozen or showing a dialog)`)), timeoutMs);
      }),
    ])) as T;
  } finally {
    clearTimeout(timer);
  }
}
