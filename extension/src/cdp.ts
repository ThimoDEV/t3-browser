// Thin wrapper around chrome.debugger: one attachment per tab, shared by the built-in
// commands and by the CDP relay that agent-browser connects through.

type EventListener = (tabId: number, method: string, params: unknown, childSessionId?: string) => void;
type DetachListener = (tabId: number, reason: string) => void;

const ATTACH_TIMEOUT_MS = 10_000;
const attached = new Set<number>();
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

export async function attach(tabId: number): Promise<void> {
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
      // Already attached by us in a previous service-worker life: adopt it.
      if (!/already attached/i.test(msg)) {
        throw new Error(
          /Cannot access|chrome:\/\/|chrome-extension:\/\//i.test(msg)
            ? "Chrome does not allow extensions to control this page (browser-internal or Web Store page)."
            : `Could not attach to the tab: ${msg}`,
        );
      }
    }
    attached.add(tabId);
    // Page events report dialogs and navigations. Runtime is not enabled: nothing here uses its
    // events (evaluating code works without it), and enabling it streams every console message
    // and execution context of the page to the extension. It was also a classic bot-detection
    // signal in older Chrome versions. CDP clients on the relay may still enable it themselves.
    await send(tabId, "Page.enable").catch(() => {});
  })().finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}

export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

const SEND_TIMEOUT_MS = 30_000;

export async function send<T = any>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
  childSessionId?: string,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<T> {
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
