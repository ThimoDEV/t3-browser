// Injected into tabs an agent is controlling. Shows that T3 Code is in control and lets the
// user take the tab back with Esc. Lives in a closed shadow root with aria-hidden so it never
// shows up in the agent's own accessibility snapshot.

interface OverlayApi {
  show(label: string): void;
  hide(): void;
  pulse(x: number, y: number): void;
  /** The agent is about to send input: ignore Esc and let clicks pass through the pill. */
  agentActing(ms: number): void;
}

declare global {
  interface Window {
    __t3BrowserOverlay?: OverlayApi;
  }
}

(() => {
  if (window.top !== window || window.__t3BrowserOverlay) return;

  const host = document.createElement("t3-browser-overlay");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .frame {
        position: fixed; inset: 0; pointer-events: none;
        box-shadow: inset 0 0 0 2px rgba(124, 92, 255, .9), inset 0 0 28px 4px rgba(124, 92, 255, .35);
        animation: breathe 2.4s ease-in-out infinite;
      }
      @keyframes breathe { 50% { box-shadow: inset 0 0 0 2px rgba(124,92,255,.65), inset 0 0 40px 8px rgba(124,92,255,.22); } }
      .pill {
        position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
        display: flex; align-items: center; gap: 10px;
        font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #f5f3ff; background: rgba(24, 20, 38, .92);
        border: 1px solid rgba(124, 92, 255, .6); border-radius: 999px;
        padding: 9px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
        pointer-events: auto; user-select: none;
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #8b6cff; box-shadow: 0 0 0 0 rgba(139,108,255,.7); animation: ping 1.6s infinite; }
      @keyframes ping { 70% { box-shadow: 0 0 0 8px rgba(139,108,255,0); } 100% { box-shadow: 0 0 0 0 rgba(139,108,255,0); } }
      kbd { font: 600 11px/1 ui-monospace, monospace; background: rgba(255,255,255,.12); border-radius: 4px; padding: 3px 5px; }
      button { all: unset; cursor: pointer; color: #c4b5fd; font-weight: 600; }
      button:hover { color: #fff; }
      .cursor {
        position: fixed; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%;
        border: 2px solid #8b6cff; background: rgba(139,108,255,.25);
        opacity: 0; transition: left .25s ease, top .25s ease, opacity .2s;
      }
      .cursor.click { animation: click .45s ease-out; }
      @keyframes click { 0% { transform: scale(.6); } 60% { transform: scale(1.5); opacity: .9; } 100% { transform: scale(1); } }
      .hidden { display: none !important; }
    </style>
    <div class="frame"></div>
    <div class="cursor"></div>
    <div class="pill"><span class="dot"></span><span class="label"></span><kbd>Esc</kbd><button type="button">Stop</button></div>
  `;
  const frame = root.querySelector(".frame") as HTMLElement;
  const pill = root.querySelector(".pill") as HTMLElement;
  const label = root.querySelector(".label") as HTMLElement;
  const cursor = root.querySelector(".cursor") as HTMLElement;
  const stop = root.querySelector("button") as HTMLButtonElement;

  let visible = false;
  let escSuppressedUntil = 0;
  let passthroughTimer = 0;

  const interrupt = (reason: string) => {
    chrome.runtime.sendMessage({ kind: "interrupt", reason }).catch(() => {});
  };

  stop.addEventListener("click", () => interrupt("stop-button"));
  window.addEventListener(
    "keydown",
    (e) => {
      if (!visible || e.key !== "Escape" || !e.isTrusted) return;
      // The agent itself may press Escape through CDP; those presses are announced first.
      if (Date.now() < escSuppressedUntil) return;
      interrupt("escape");
    },
    true,
  );

  const mount = () => {
    if (!host.isConnected) (document.documentElement ?? document.body)?.appendChild(host);
  };

  window.__t3BrowserOverlay = {
    show(text: string) {
      label.textContent = text;
      visible = true;
      frame.classList.remove("hidden");
      pill.classList.remove("hidden");
      mount();
    },
    hide() {
      visible = false;
      host.remove();
    },
    pulse(x: number, y: number) {
      if (!visible) return;
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
      cursor.style.opacity = "1";
      cursor.classList.remove("click");
      void cursor.offsetWidth;
      cursor.classList.add("click");
      clearTimeout((cursor as unknown as { _t?: number })._t);
      (cursor as unknown as { _t?: number })._t = window.setTimeout(() => (cursor.style.opacity = "0"), 1600);
    },
    agentActing(ms: number) {
      escSuppressedUntil = Date.now() + ms;
      pill.style.pointerEvents = "none";
      clearTimeout(passthroughTimer);
      passthroughTimer = window.setTimeout(() => (pill.style.pointerEvents = ""), ms);
    },
  };

  // Single-page apps sometimes replace <html> children wholesale; keep the overlay attached.
  new MutationObserver(() => visible && mount()).observe(document, { childList: true, subtree: false });
})();

export {};
